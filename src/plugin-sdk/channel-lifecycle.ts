type CloseAwareServer = {
  once: (event: "close", listener: () => void) => unknown;
};

type AbortSignalLike = Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener">;

function addAbortOnce(signal: AbortSignalLike | undefined, listener: () => void): () => void {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    listener();
    return () => {};
  }
  const onAbort = () => listener();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Return a promise that resolves when the signal is aborted.
 *
 * If no signal is provided, the promise stays pending forever.
 */
export function waitUntilAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const dispose = addAbortOnce(signal, resolve);
    void dispose;
  });
}

/**
 * Keep a channel/provider task pending until the HTTP server closes.
 *
 * When an abort signal is provided, `onAbort` is invoked once and should
 * trigger server shutdown. The returned promise resolves only after `close`.
 */
export async function keepHttpServerTaskAlive(params: {
  server: CloseAwareServer;
  abortSignal?: AbortSignal;
  onAbort?: () => void | Promise<void>;
}): Promise<void> {
  const { server, abortSignal, onAbort } = params;
  let abortTask: Promise<void> = Promise.resolve();
  let abortTriggered = false;

  const triggerAbort = () => {
    if (abortTriggered) {
      return;
    }
    abortTriggered = true;
    abortTask = Promise.resolve(onAbort?.()).then(() => undefined);
  };

  const disposeAbortListener = addAbortOnce(abortSignal, triggerAbort);

  await new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  disposeAbortListener();
  await abortTask;
}
