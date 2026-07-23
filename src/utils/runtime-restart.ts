export const RUNNING_STATE = 2;

const DEFAULT_STOP_WAIT_ATTEMPTS = 10;
const DEFAULT_STOP_WAIT_INTERVAL_MS = 150;

export type RuntimeStateProvider = () => Promise<number | null | undefined>;

export type RuntimeOperationResult = {
  stoppedBeforeRun: boolean;
  restartedAfterRun: boolean;
  retriedAfterRunningPrecondition: boolean;
  restartError: unknown | null;
};

export class RuntimeRestartError extends Error {
  readonly phase: 'restart' | 'restore';
  readonly operationError: unknown;
  readonly restartError: unknown;

  constructor(phase: 'restart' | 'restore', operationError: unknown, restartError: unknown) {
    const message = phase === 'restart'
      ? `配置已保存，但重新启动失败: ${formatErrorText(restartError)}`
      : `保存失败: ${formatErrorText(operationError)}；恢复运行失败: ${formatErrorText(restartError)}`;
    super(message);
    this.name = 'RuntimeRestartError';
    this.phase = phase;
    this.operationError = operationError;
    this.restartError = restartError;
  }
}

export function isRunningState(state: number | null | undefined): boolean {
  return state === RUNNING_STATE;
}

export function formatErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isRunningPreconditionError(error: unknown): boolean {
  const text = formatErrorText(error).toUpperCase();
  return (
    text.includes('FAILED_PRECONDITION') ||
    text.includes('FAILEDPRECONDITION') ||
    text.includes('FAILED PRECONDITION') ||
    text.includes('RUNNING') ||
    text.includes('运行中') ||
    text.includes('状态不允许') ||
    text.includes('不允许更新')
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function waitUntilNotRunning(loadState: RuntimeStateProvider): Promise<void> {
  for (let attempt = 0; attempt < DEFAULT_STOP_WAIT_ATTEMPTS; attempt += 1) {
    const state = await loadState();
    if (!isRunningState(state)) {
      return;
    }

    if (attempt < DEFAULT_STOP_WAIT_ATTEMPTS - 1) {
      await sleep(DEFAULT_STOP_WAIT_INTERVAL_MS);
    }
  }
}

async function shouldRetryAfterRunningPrecondition(
  error: unknown,
  loadState?: RuntimeStateProvider,
): Promise<boolean> {
  if (!isRunningPreconditionError(error) || !loadState) {
    return false;
  }

  try {
    return isRunningState(await loadState());
  } catch {
    return false;
  }
}

export async function runWithRuntimeRestart(options: {
  initialState: number | null | undefined;
  loadState?: RuntimeStateProvider;
  stop: () => Promise<void>;
  run: () => Promise<void>;
  start: () => Promise<void>;
  restoreStart?: () => Promise<void>;
  restartAfterRun?: boolean;
  failOnRestartError?: boolean;
}): Promise<RuntimeOperationResult> {
  const failOnRestartError = options.failOnRestartError ?? true;
  const result: RuntimeOperationResult = {
    stoppedBeforeRun: false,
    restartedAfterRun: false,
    retriedAfterRunningPrecondition: false,
    restartError: null,
  };

  const runStopped = async (retriedAfterRunningPrecondition: boolean): Promise<RuntimeOperationResult> => {
    result.retriedAfterRunningPrecondition = retriedAfterRunningPrecondition;
    await options.stop();
    result.stoppedBeforeRun = true;

    if (options.loadState) {
      await waitUntilNotRunning(options.loadState);
    }

    try {
      await options.run();
    } catch (operationError) {
      try {
        await (options.restoreStart ?? options.start)();
      } catch (restartError) {
        throw new RuntimeRestartError('restore', operationError, restartError);
      }
      throw operationError;
    }

    if (options.restartAfterRun === false) {
      return result;
    }

    try {
      await options.start();
      result.restartedAfterRun = true;
    } catch (restartError) {
      result.restartError = restartError;
      if (failOnRestartError) {
        throw new RuntimeRestartError('restart', null, restartError);
      }
    }

    return result;
  };

  if (isRunningState(options.initialState)) {
    return runStopped(false);
  }

  try {
    await options.run();
    return result;
  } catch (error) {
    if (await shouldRetryAfterRunningPrecondition(error, options.loadState)) {
      return runStopped(true);
    }
    throw error;
  }
}
