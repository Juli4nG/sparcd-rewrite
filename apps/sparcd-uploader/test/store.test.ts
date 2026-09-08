import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannedFile } from '../src/lib/scanFiles';
import type { ProcessResponse } from '../src/lib/processPool';
import type { FileValidation } from '../src/lib/validation';
import type { NaiveDateTime } from '../src/lib/exifTime';
import type { UploadPhase, UploadSnapshot } from '../src/lib/upload';

const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
(globalThis as any).window = Object.assign(globalThis, {
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: storage(),
  sessionStorage: storage(),
});
const { useStore } = await import('../src/store');
const { forwardReadyToStreamingRun, maybeCloseStreamingQueue } = await import('../src/lib/streamingBridge');

const NAIVE: NaiveDateTime = { year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0 };

function scanned(id: string, over: Partial<ScannedFile> = {}): ScannedFile {
  const file = new File([new Uint8Array(64)], id.split('/').pop() ?? 'x.jpg', { type: 'image/jpeg' });
  return {
    id,
    file,
    relPath: id,
    fileName: file.name,
    size: file.size,
    mediaKind: 'image',
    ...over,
  };
}

function success(id: string, over: Partial<ProcessResponse> = {}): ProcessResponse {
  return {
    id,
    sha256: `sha-${id}`,
    exifNaive: NAIVE,
    exifCamera: 'Reconyx HF2X',
    gps: { lat: 31.5, lon: -110.2 },
    width: 64,
    height: 48,
    mimeType: 'image/jpeg',
    mediaKind: 'image',
    ...over,
  };
}

function snapshot(sessionId: string, phase: UploadPhase): UploadSnapshot {
  return {
    version: 1,
    sessionId,
    phase,
    dryRun: false,
    files: [],
    uploadedBytes: 0,
    skippedBytes: 0,
    totalBytes: 0,
    log: [],
    bucket: 'sparcd-test',
    collectionUuid: 'collection',
  };
}

beforeEach(() => {
  useStore.setState({
    files: [],
    validations: {},
    processing: false,
    batchToken: 0,
    step: 'drop',
    dirHandle: null,
    fileAccessMode: 'reselect-required',
    activeRun: null,
    streamingRun: null,
    streamingQueueClosed: false,
    activeSnap: null,
    activeRunGeneration: 0,
    activeRunReserved: false,
    activeRunSource: null,
    historyResumePreparation: null,
  });
});

describe('active run ownership', () => {
  it('ignores a late snapshot after the run is invalidated', () => {
    const store = useStore.getState();
    const generation = store.beginActiveRun();
    const cancel = vi.fn();
    store.setActiveRun({ cancel, done: Promise.resolve() }, generation!);

    store.cancelActiveRun();
    store.setActiveSnap(snapshot('stale', 'error'), generation!);

    expect(cancel).toHaveBeenCalledOnce();
    expect(useStore.getState().activeRun).toBeNull();
    expect(useStore.getState().activeSnap).toBeNull();
    expect(useStore.getState().activeRunSource).toBeNull();
  });

  it('refuses a second reservation without cancelling or replacing the first', () => {
    const store = useStore.getState();
    const cancel = vi.fn();
    const generation = store.beginActiveRun();
    store.setActiveRun({ cancel, done: Promise.resolve() }, generation!);

    expect(store.beginActiveRun()).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(useStore.getState().activeRunReserved).toBe(true);
    expect(useStore.getState().activeRunSource).toBe('upload');
  });

  it('cancels a runner attached after its reservation was invalidated', () => {
    const store = useStore.getState();
    const generation = store.beginActiveRun();
    const cancel = vi.fn();

    store.cancelActiveRun();
    store.setActiveRun({ cancel, done: Promise.resolve() }, generation!);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('releases the reservation but retains a terminal snapshot for display', () => {
    const store = useStore.getState();
    const generation = store.beginActiveRun();
    const done = snapshot('finished', 'done');

    store.setActiveSnap(done, generation!);

    expect(useStore.getState().activeRunReserved).toBe(false);
    expect(useStore.getState().activeSnap).toBe(done);
    expect(useStore.getState().activeRunSource).toBe('upload');
    expect(store.beginActiveRun()).not.toBeNull();
  });
});

describe('streaming bridge ownership', () => {
  const streamingRun = () => ({
    cancel: vi.fn(),
    done: Promise.resolve(),
    notifyReady: vi.fn(),
    close: vi.fn(),
  });

  it('forwards ready files and closes a complete queue exactly once', () => {
    useStore.getState().setFiles([scanned('a.jpg')]);
    useStore.getState().applyProgress([], [success('a.jpg')]);
    const run = streamingRun();
    const generation = useStore.getState().beginActiveRun();
    useStore.getState().setActiveRun(run, generation!, run);

    forwardReadyToStreamingRun([{ id: 'a.jpg' }]);
    const files = useStore.getState().files;
    maybeCloseStreamingQueue(files);
    maybeCloseStreamingQueue(files);

    expect(run.notifyReady).toHaveBeenCalledWith([expect.objectContaining({ id: 'a.jpg' })]);
    expect(run.close).toHaveBeenCalledTimes(1);
    expect(run.close).toHaveBeenCalledWith(files);
    expect(useStore.getState().streamingQueueClosed).toBe(true);
  });

  it('atomically drops the old bridge owner when a plain run replaces it or the run is cleared', () => {
    useStore.getState().setFiles([scanned('a.jpg')]);
    useStore.getState().applyProgress([], [success('a.jpg')]);
    const old = streamingRun();
    const resume = { cancel: vi.fn(), done: Promise.resolve() };
    const oldGeneration = useStore.getState().beginActiveRun();
    useStore.getState().setActiveRun(old, oldGeneration!, old);

    useStore.getState().setActiveSnap(snapshot('old', 'done'), oldGeneration!);
    const resumeGeneration = useStore.getState().beginActiveRun();
    useStore.getState().setActiveRun(resume, resumeGeneration!);
    forwardReadyToStreamingRun([{ id: 'a.jpg' }]);
    maybeCloseStreamingQueue(useStore.getState().files);

    expect(useStore.getState().activeRun).toBe(resume);
    expect(useStore.getState().streamingRun).toBeNull();
    expect(old.notifyReady).not.toHaveBeenCalled();
    expect(old.close).not.toHaveBeenCalled();

    useStore.getState().clearActiveRun();
    expect(useStore.getState()).toMatchObject({
      activeRun: null,
      streamingRun: null,
      streamingQueueClosed: false,
    });
  });

  it('cleans up a settled owner without detaching a newer streaming run', async () => {
    let finishOld!: () => void;
    let finishNew!: () => void;
    const old = {
      ...streamingRun(),
      done: new Promise<void>((resolve) => { finishOld = resolve; }),
    };
    const replacement = {
      ...streamingRun(),
      done: new Promise<void>((resolve) => { finishNew = resolve; }),
    };

    const oldGeneration = useStore.getState().beginActiveRun();
    useStore.getState().setActiveRun(old, oldGeneration!, old);
    useStore.getState().setActiveSnap(snapshot('old', 'done'), oldGeneration!);
    const replacementGeneration = useStore.getState().beginActiveRun();
    useStore.getState().setActiveRun(replacement, replacementGeneration!, replacement);
    finishOld();
    await old.done;
    await Promise.resolve();
    expect(useStore.getState().streamingRun).toBe(replacement);

    finishNew();
    await replacement.done;
    await Promise.resolve();
    expect(useStore.getState()).toMatchObject({
      activeRun: replacement,
      streamingRun: null,
      streamingQueueClosed: false,
    });
  });
});

describe('store persistence', () => {
  it('persists wizard prefs and never the in-flight batch', () => {
    useStore.getState().setUploaderUser('Ada Lovelace');
    useStore.getState().setUploadDescription('Sky Island transect');
    useStore.getState().setSelectedBucket('bucket::uuid');
    useStore.getState().setSelectedLocationKey('loc-7');
    useStore.getState().setUploadTimeZone('America/Phoenix');
    useStore.getState().setDryRun(false);
    useStore.getState().setConcurrencyMode('manual');
    useStore.getState().setUploadConcurrency(16);
    useStore.getState().setFiles([scanned('a.jpg')]);
    const generation = useStore.getState().beginActiveRun();
    useStore.getState().setActiveSnap({ sessionId: 'session-1' } as never, generation!);

    const persisted = JSON.parse(window.sessionStorage.getItem('sparcd-uploader-session')!).state;

    expect(persisted).toEqual({
      elevationUnit: 'meters',
      uploaderUser: 'Ada Lovelace',
      uploadDescription: 'Sky Island transect',
      selectedBucket: 'bucket::uuid',
      selectedLocationKey: 'loc-7',
      uploadTimeZone: 'America/Phoenix',
      dryRun: false,
      concurrencyMode: 'manual',
      uploadConcurrency: 16,
    });
  });
});

describe('History resume preparation', () => {
  it('keeps the active session and progress in shared state', () => {
    const store = useStore.getState();
    store.beginHistoryResumePreparation('session-a');
    store.setHistoryResumeProgress('session-a', 7, 12);

    expect(useStore.getState().historyResumePreparation).toEqual({
      sessionId: 'session-a',
      progress: { done: 7, total: 12 },
    });
  });

  it('ignores stale progress and cleanup from an older preparation', () => {
    const store = useStore.getState();
    store.beginHistoryResumePreparation('session-new');
    store.setHistoryResumeProgress('session-old', 4, 10);
    store.clearHistoryResumePreparation('session-old');

    expect(useStore.getState().historyResumePreparation).toEqual({
      sessionId: 'session-new',
      progress: null,
    });
  });
});

describe('store applyProgress', () => {
  it('marks started ids processing and leaves queued others untouched', () => {
    useStore.getState().setFiles([scanned('a.jpg'), scanned('b.jpg'), scanned('c.jpg')]);

    useStore.getState().applyProgress(['a.jpg', 'b.jpg'], []);

    const states = Object.fromEntries(useStore.getState().files.map((f) => [f.id, f.processState]));
    expect(states).toEqual({ 'a.jpg': 'processing', 'b.jpg': 'processing', 'c.jpg': 'queued' });
  });

  it('applies success and error results', () => {
    useStore.getState().setFiles([scanned('a.jpg'), scanned('b.jpg')]);

    useStore.getState().applyProgress(
      [],
      [success('a.jpg'), { id: 'b.jpg', error: 'decode failed' }],
    );

    const files = useStore.getState().files;
    expect(files[0]).toMatchObject({
      processState: 'ready',
      sha256: 'sha-a.jpg',
      exifNaive: NAIVE,
      exifCamera: 'Reconyx HF2X',
      gps: { lat: 31.5, lon: -110.2 },
      width: 64,
      height: 48,
      mimeType: 'image/jpeg',
    });
    expect(files[1]).toMatchObject({ processState: 'error', processError: 'decode failed' });
  });

  it('lets a result win over a started marker in the same flush', () => {
    useStore.getState().setFiles([scanned('a.jpg')]);

    useStore.getState().applyProgress(['a.jpg'], [success('a.jpg')]);

    expect(useStore.getState().files[0].processState).toBe('ready');
  });

  it('updates validations only for result files', () => {
    useStore
      .getState()
      .setFiles([scanned('unsafe', { relPath: 'folder/../x.jpg' }), scanned('other.jpg')]);
    const unchanged: FileValidation = { severity: 'ok', issues: [] };
    const staleUnsafe: FileValidation = { severity: 'ok', issues: [] };
    useStore.setState({ validations: { unsafe: staleUnsafe, 'other.jpg': unchanged } });

    useStore.getState().applyProgress([], [success('unsafe')]);

    const validations = useStore.getState().validations;
    expect(validations.unsafe.severity).toBe('error');
    expect(validations.unsafe.issues.some((i) => i.message.includes('Unsafe filename'))).toBe(true);
    expect(validations['other.jpg']).toBe(unchanged);
  });

  it('defers duplicate warnings until revalidate', () => {
    useStore.getState().setFiles([scanned('a.jpg'), scanned('b.jpg')]);

    useStore
      .getState()
      .applyProgress([], [success('a.jpg', { sha256: 'dup' }), success('b.jpg', { sha256: 'dup' })]);

    expect(useStore.getState().validations['a.jpg'].severity).toBe('ok');
    expect(useStore.getState().validations['b.jpg'].severity).toBe('ok');

    useStore.getState().revalidate();

    expect(useStore.getState().validations['a.jpg'].severity).toBe('warning');
    expect(useStore.getState().validations['b.jpg'].severity).toBe('warning');
    expect(useStore.getState().validations['a.jpg'].issues.some((i) => i.message.includes('Duplicate'))).toBe(true);
  });

  it(
    'processes a 17,000-file batch in bounded flush time',
    () => {
      const count = 17_000;
      const flushSize = 200;
      const file = new File([new Uint8Array(64)], 'x.jpg', { type: 'image/jpeg' });
      const files = Array.from({ length: count }, (_, i) =>
        scanned(`IMG_${i.toString().padStart(5, '0')}.jpg`, { file, fileName: file.name, size: file.size }),
      );
      useStore.getState().setFiles(files);

      const startedAt = performance.now();
      for (let offset = 0; offset < count; offset += flushSize) {
        const ids = files.slice(offset, offset + flushSize).map((f) => f.id);
        useStore.getState().applyProgress(
          ids,
          ids.map((id, i) => success(id, { sha256: `sha-${offset + i}` })),
        );
      }
      useStore.getState().revalidate();
      const elapsed = performance.now() - startedAt;

      console.log(`store applyProgress 17000 files: ${elapsed.toFixed(1)} ms`);
      expect(elapsed).toBeLessThan(2000);
    },
    30_000,
  );
});
