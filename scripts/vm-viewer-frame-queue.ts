export interface FrameResult {
  frameSequence: number;
  inputSequence: number;
}

export interface FrameQueue<Input> {
  post(value: Input): Promise<void>;
  refresh(): Promise<FrameResult>;
  readonly queue: Promise<void>;
  readonly frameSequence: number;
}

interface FrameQueueOptions<Input, Frame> {
  send(value: Input): void | PromiseLike<void>;
  capture(sequence: number, inputSequence: number): Frame | PromiseLike<Frame>;
  display(frame: Frame): void | PromiseLike<void>;
  discard?(frame: Frame): void;
  onError?(error: unknown): void;
  settleMs?: number;
}

interface FrameWaiter {
  sequence: number;
  resolve(result: FrameResult): void;
  reject(error: unknown): void;
}

export function createFrameQueue<Input, Frame>({
  send,
  capture,
  display,
  discard = () => {},
  onError = () => {},
  settleMs = 600,
}: FrameQueueOptions<Input, Frame>): FrameQueue<Input> {
  let queue = Promise.resolve();
  let inputSequence = 0;
  let completedInputSequence = 0;
  let lastInputAt = 0;
  let requestSequence = 0;
  let frameSequence = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTask: Promise<void> | undefined;
  let waiters: FrameWaiter[] = [];

  function clearRefreshTimer() {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  function post(value: Input) {
    const sequence = ++inputSequence;
    clearRefreshTimer();
    queue = queue.then(() => send(value)).catch(onError).then(() => {
      completedInputSequence = sequence;
      lastInputAt = Date.now();
      if (sequence === inputSequence && !refreshTask) {
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          refresh().catch(onError);
        }, settleMs);
      }
    });
    return queue;
  }

  async function capturePending() {
    while (waiters.length) {
      const pendingInputs = queue;
      await pendingInputs;
      if (pendingInputs !== queue) continue;
      const delay = settleMs - (Date.now() - lastInputAt);
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      if (pendingInputs !== queue) continue;
      const captureInput = completedInputSequence;
      const captureSequence = requestSequence;
      const frame = await capture(captureSequence, captureInput);
      try {
        if (captureInput !== inputSequence) continue;
        await display(frame);
        frameSequence = captureSequence;
        const completed = waiters.filter(waiter => waiter.sequence <= frameSequence);
        waiters = waiters.filter(waiter => waiter.sequence > frameSequence);
        for (const waiter of completed) waiter.resolve({ frameSequence, inputSequence: captureInput });
      } finally {
        discard(frame);
      }
    }
  }

  function startCapture() {
    if (refreshTask) return;
    refreshTask = Promise.resolve().then(capturePending).catch((error: unknown) => {
      const failed = waiters;
      waiters = [];
      for (const waiter of failed) waiter.reject(error);
    }).finally(() => {
      refreshTask = undefined;
      if (waiters.length) startCapture();
    });
  }

  function refresh() {
    clearRefreshTimer();
    const sequence = ++requestSequence;
    const result = new Promise<FrameResult>((resolve, reject) => waiters.push({ sequence, resolve, reject }));
    startCapture();
    return result;
  }

  return { post, refresh, get queue() { return queue; }, get frameSequence() { return frameSequence; } };
}
