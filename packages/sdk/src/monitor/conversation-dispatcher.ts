import type { PermissionDecision, PermissionOption, PermissionRequest } from "../agent/interface.js";

export type ConversationTaskPriority = "control" | "normal";

export type ConversationTask = {
  conversationId: string;
  priority: ConversationTaskPriority;
  run: () => Promise<void>;
};

type QueuedNormalTask = {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ConversationRuntimeInternal = {
  conversationId: string;
  resetVersion: number;
  normalQueue: QueuedNormalTask[];
  normalPumpRunning: boolean;
  activeNormalTask: Promise<void> | null;
  controlTail: Promise<void>;
  controlInFlight: number;
  pendingPermission: PendingPermission | null;
  activeTypingStop: (() => Promise<void>) | null;
  cancelTypingOnAttach: boolean;
};

type PendingPermission = {
  requestId: string;
  options: PermissionOption[];
  noticeAbortController: AbortController;
  resolve: (decision: PermissionDecision) => void;
};

function createRuntime(conversationId: string): ConversationRuntimeInternal {
  return {
    conversationId,
    resetVersion: 0,
    normalQueue: [],
    normalPumpRunning: false,
    activeNormalTask: null,
    controlTail: Promise.resolve(),
    controlInFlight: 0,
    pendingPermission: null,
    activeTypingStop: null,
    cancelTypingOnAttach: false,
  };
}

function getPermissionOptionPriority(option: PermissionOption): number {
  const normalized = `${option.kind ?? ""} ${option.name}`.toLowerCase().replaceAll("-", "_");
  if (normalized.includes("once") || normalized.includes("one_shot")) {
    return 0;
  }
  if (
    normalized.includes("always") ||
    normalized.includes("remember") ||
    normalized.includes("persist") ||
    normalized.includes("session") ||
    normalized.includes("forever")
  ) {
    return 2;
  }
  return 1;
}

function selectPermissionOption(
  options: PermissionOption[],
  prefix: "allow" | "reject",
): PermissionOption | undefined {
  const matchingOptions = options.filter((option) => option.kind?.startsWith(prefix));
  if (matchingOptions.length === 0) {
    return undefined;
  }

  return matchingOptions.reduce((bestOption, option) =>
    getPermissionOptionPriority(option) < getPermissionOptionPriority(bestOption)
      ? option
      : bestOption,
  );
}

function selectOneShotPermissionOption(
  options: PermissionOption[],
  prefix: "allow" | "reject",
): PermissionOption | undefined {
  const option = selectPermissionOption(options, prefix);
  if (!option || getPermissionOptionPriority(option) !== 0) {
    return undefined;
  }
  return option;
}

export function createConversationDispatcher() {
  // weixin-claw currently drives a single active WeChat session, but the SDK
  // still uses conversationId as the stable key for serial turn ordering.
  const runtimes = new Map<string, ConversationRuntimeInternal>();

  function getOrCreateRuntime(conversationId: string): ConversationRuntimeInternal {
    let runtime = runtimes.get(conversationId);
    if (!runtime) {
      runtime = createRuntime(conversationId);
      runtimes.set(conversationId, runtime);
    }
    return runtime;
  }

  function cleanupRuntime(runtime: ConversationRuntimeInternal): void {
    if (
      runtime.activeNormalTask === null &&
      !runtime.normalPumpRunning &&
      runtime.normalQueue.length === 0 &&
      runtime.controlInFlight === 0 &&
      runtime.pendingPermission === null &&
      runtime.activeTypingStop === null &&
      !runtime.cancelTypingOnAttach
    ) {
      runtimes.delete(runtime.conversationId);
    }
  }

  function getConversationResetVersion(conversationId: string): number {
    return getOrCreateRuntime(conversationId).resetVersion;
  }

  function markConversationReset(conversationId: string): number {
    const runtime = getOrCreateRuntime(conversationId);
    runtime.resetVersion += 1;
    return runtime.resetVersion;
  }

  async function pumpNormalQueue(runtime: ConversationRuntimeInternal): Promise<void> {
    if (runtime.normalPumpRunning) {
      return;
    }

    runtime.normalPumpRunning = true;
    try {
      while (runtime.normalQueue.length > 0) {
        // Always give already-arrived control work a chance before starting the next normal task.
        await runtime.controlTail;

        const task = runtime.normalQueue.shift();
        if (!task) {
          continue;
        }

        const activeTask = task.run();
        runtime.activeNormalTask = activeTask;

        try {
          await activeTask;
          task.resolve();
        } catch (error) {
          task.reject(error);
        } finally {
          runtime.activeNormalTask = null;
          // A deferred typing cancel only applies to the turn that was active
          // when reset arrived. If that turn finishes before attaching typing,
          // do not leak the flag into the next turn.
          if (runtime.activeTypingStop === null) {
            runtime.cancelTypingOnAttach = false;
          }
        }
      }
    } finally {
      runtime.normalPumpRunning = false;
      cleanupRuntime(runtime);
    }
  }

  function dispatchNormal(runtime: ConversationRuntimeInternal, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      runtime.normalQueue.push({ run, resolve, reject });
      void pumpNormalQueue(runtime);
    });
  }

  function dispatchControl(
    runtime: ConversationRuntimeInternal,
    run: () => Promise<void>,
  ): Promise<void> {
    runtime.controlInFlight += 1;

    const result = runtime.controlTail.then(run, run);
    runtime.controlTail = result
      .catch(() => {})
      .finally(() => {
        runtime.controlInFlight -= 1;
        cleanupRuntime(runtime);
      });

    return result;
  }

  function requestPermission(
    conversationId: string,
    input: PermissionRequest,
  ): Promise<PermissionDecision> {
    const runtime = getOrCreateRuntime(conversationId);
    if (runtime.pendingPermission) {
      throw new Error(`Permission request already pending for conversation=${conversationId}`);
    }

    return new Promise<PermissionDecision>((resolve) => {
      const pendingPermission: PendingPermission = {
        requestId: input.requestId,
        options: input.options,
        noticeAbortController: new AbortController(),
        resolve: (decision) => {
          if (runtime.pendingPermission !== pendingPermission) {
            return;
          }
          runtime.pendingPermission = null;
          pendingPermission.noticeAbortController.abort();
          resolve(decision);
          cleanupRuntime(runtime);
        },
      };
      runtime.pendingPermission = pendingPermission;
    });
  }

  function isPendingPermission(conversationId: string, requestId: string): boolean {
    const pendingPermission = runtimes.get(conversationId)?.pendingPermission;
    return pendingPermission?.requestId === requestId;
  }

  function getPendingPermissionNoticeAbortSignal(
    conversationId: string,
    requestId: string,
  ): AbortSignal | undefined {
    const pendingPermission = runtimes.get(conversationId)?.pendingPermission;
    if (!pendingPermission || pendingPermission.requestId !== requestId) {
      return undefined;
    }
    return pendingPermission.noticeAbortController.signal;
  }

  function approvePendingPermission(conversationId: string): "resolved" | "missing" | "unsupported" {
    const runtime = runtimes.get(conversationId);
    const pendingPermission = runtime?.pendingPermission;
    if (!runtime || !pendingPermission) {
      return "missing";
    }

    const option = selectOneShotPermissionOption(pendingPermission.options, "allow");
    if (!option) {
      return "unsupported";
    }

    pendingPermission.resolve({
      outcome: "selected",
      optionId: option.id,
    });
    return "resolved";
  }

  function rejectPendingPermission(conversationId: string): "resolved" | "missing" | "unsupported" {
    const runtime = runtimes.get(conversationId);
    const pendingPermission = runtime?.pendingPermission;
    if (!runtime || !pendingPermission) {
      return "missing";
    }

    if (!selectOneShotPermissionOption(pendingPermission.options, "reject")) {
      return "unsupported";
    }

    pendingPermission.resolve({
      outcome: "rejected",
    });
    return "resolved";
  }

  function clearPendingPermission(conversationId: string): boolean {
    const runtime = runtimes.get(conversationId);
    const pendingPermission = runtime?.pendingPermission;
    if (!runtime || !pendingPermission) {
      return false;
    }

    pendingPermission.resolve({
      outcome: "cancelled",
    });
    return true;
  }

  function attachTypingIndicator(
    conversationId: string,
    stop: () => void | Promise<void>,
  ): () => void {
    const runtime = getOrCreateRuntime(conversationId);
    const wrappedStop = async () => {
      if (runtime.activeTypingStop !== wrappedStop) {
        return;
      }
      runtime.activeTypingStop = null;
      await stop();
      cleanupRuntime(runtime);
    };

    runtime.activeTypingStop = wrappedStop;

    if (runtime.cancelTypingOnAttach) {
      runtime.cancelTypingOnAttach = false;
      void wrappedStop();
    }

    return () => {
      if (runtime.activeTypingStop !== wrappedStop) {
        return;
      }
      runtime.activeTypingStop = null;
      cleanupRuntime(runtime);
    };
  }

  async function cancelActiveTyping(conversationId: string): Promise<boolean> {
    const runtime = runtimes.get(conversationId);
    if (!runtime) {
      return false;
    }

    const stop = runtime.activeTypingStop;
    if (stop) {
      await stop();
      return true;
    }

    if (runtime.activeNormalTask !== null || runtime.normalPumpRunning) {
      runtime.cancelTypingOnAttach = true;
      return true;
    }

    return false;
  }

  return {
    getConversationResetVersion,
    markConversationReset,
    dispatch(task: ConversationTask): Promise<void> {
      const runtime = getOrCreateRuntime(task.conversationId);
      if (task.priority === "control") {
        return dispatchControl(runtime, task.run);
      }
      return dispatchNormal(runtime, task.run);
    },
    requestPermission,
    isPendingPermission,
    getPendingPermissionNoticeAbortSignal,
    approvePendingPermission,
    rejectPendingPermission,
    clearPendingPermission,
    attachTypingIndicator,
    cancelActiveTyping,
  };
}
