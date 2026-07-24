// Shared test helpers. Not a *.test.ts file, so the runner won't execute it
// directly — it's imported by the suites.

/** Build a 200 JSON response (override status/headers via `init`). */
export const json = (data: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/**
 * A fetch that never resolves on its own but rejects the moment its signal
 * aborts — perfect for exercising timeout and abort-previous without real time.
 */
export const slow: typeof fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
