import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSession: vi.fn(),
  resumeUpload: vi.fn(),
}));

vi.mock('../src/lib/db', () => ({ loadSession: mocks.loadSession }));
vi.mock('../src/lib/upload', () => ({ resumeUpload: mocks.resumeUpload }));

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

(globalThis as any).window = Object.assign(globalThis, {
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: storage(),
  sessionStorage: storage(),
});

const { useStore } = await import('../src/store');

const config = { accessKey: 'key', secretKey: 'secret' } as never;
const partial = () => ({
  version: 1,
  sessionId: 'session-1',
  phase: 'partial' as const,
  dryRun: false,
  files: [],
  uploadedBytes: 0,
  skippedBytes: 0,
  totalBytes: 1,
  log: [],
  bucket: 'bucket',
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  mocks.loadSession.mockReset();
  mocks.resumeUpload.mockReset();
  useStore.setState({
    s3Config: config,
    connectionId: 1,
    files: [],
    activeRun: null,
    streamingRun: null,
    streamingQueueClosed: false,
    activeSnap: partial(),
    activeRunSource: null,
    attachedFiles: new Map(),
  });
});

describe('automatic partial-run retry lifecycle', () => {
  it.each([
    ['disconnecting', () => useStore.getState().disconnect()],
    ['clearing the active run', () => useStore.getState().clearActiveRun()],
    ['resetting the batch', () => useStore.getState().resetBatch()],
    ['advancing to the next batch', () => useStore.getState().nextBatch()],
    ['replacing the connection', () => useStore.getState().connect({ accessKey: 'other' } as never, false)],
  ])('does not resurrect a stale run after %s', async (_label, invalidate) => {
    const loaded = deferred<unknown>();
    mocks.loadSession.mockReturnValueOnce(loaded.promise);
    const run = { cancel: vi.fn(), done: Promise.resolve() };
    mocks.resumeUpload.mockReturnValue(run);

    const retry = useStore.getState().retryPartialRun();
    invalidate();
    loaded.resolve({ bundle: {} });
    await retry;

    expect(mocks.resumeUpload).not.toHaveBeenCalled();
    expect(useStore.getState().activeRun).not.toBe(run);
  });

  it('does not overwrite a replacement run installed while the session loads', async () => {
    const loaded = deferred<unknown>();
    mocks.loadSession.mockReturnValueOnce(loaded.promise);
    const stale = { cancel: vi.fn(), done: Promise.resolve() };
    const replacement = { cancel: vi.fn(), done: Promise.resolve() };
    mocks.resumeUpload.mockReturnValue(stale);

    const retry = useStore.getState().retryPartialRun();
    useStore.getState().setActiveRun(replacement);
    loaded.resolve({ bundle: {} });
    await retry;

    expect(mocks.resumeUpload).not.toHaveBeenCalled();
    expect(useStore.getState().activeRun).toBe(replacement);
  });

  it('surfaces an IndexedDB failure on the run instead of rejecting', async () => {
    mocks.loadSession.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(useStore.getState().retryPartialRun()).resolves.toBeUndefined();

    expect(useStore.getState().activeSnap).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('database unavailable'),
      log: [expect.objectContaining({ kind: 'error', text: expect.stringContaining('database unavailable') })],
    });
    expect(mocks.resumeUpload).not.toHaveBeenCalled();
  });
});
