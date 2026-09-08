import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreconditionFailedError } from '@sparcd/s3-safe';
import type { S3Config } from '@sparcd/types';
import type { BatchRecord, BundleRecord, FileRecord, LoadedSession } from '../src/lib/db';
import type { FileEntry } from '../src/store';
import {
  resumeUpload,
  runStreamingUpload,
  type ConcurrencyControl,
  type UploadSnapshot,
} from '../src/lib/upload';

const manual = (lanes: number): ConcurrencyControl => ({ mode: 'manual', get: () => lanes });

type FakeClient = {
  statObject: ReturnType<typeof vi.fn>;
  writeImmutableStream: ReturnType<typeof vi.fn>;
  writeImmutable: ReturnType<typeof vi.fn>;
  listObjects: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  client: null as FakeClient | null,
  openSession: vi.fn(),
  attachBundle: vi.fn(),
  markFileState: vi.fn(),
  markBatchComplete: vi.fn(),
}));

vi.mock('../src/lib/s3', () => ({
  getClient: vi.fn(() => mocks.client),
}));

vi.mock('../src/lib/db', () => ({
  fileRecordId: (sessionId: string, localPath: string) => `${sessionId}::${localPath}`,
  openSession: mocks.openSession,
  attachBundle: mocks.attachBundle,
  markFileState: mocks.markFileState,
  markBatchComplete: mocks.markBatchComplete,
}));

const CONFIG = {} as S3Config;

const LOCATION = {
  key: 'deployment',
  id: 'deployment',
  name: 'Deployment',
  latitude: 1,
  longitude: 2,
  elevation: 3,
};

const badRequest = () =>
  Object.assign(new Error('bad request'), {
    name: 'BadRequest',
    $metadata: { httpStatusCode: 400 },
  });

const forbidden = () =>
  Object.assign(new Error('forbidden'), {
    name: 'Forbidden',
    $metadata: { httpStatusCode: 403 },
  });

// A 403 whose specific reason couldn't be read (CORS hides the body cross-
// origin for some error responses) — the AWS SDK falls back to this generic
// name when it can't parse a code to check against known clock-skew errors.
const unknownError403 = () =>
  Object.assign(new Error('unknown'), {
    name: 'UnknownError',
    $metadata: { httpStatusCode: 403 },
  });

function makeFile(localPath: string, size = 12): File {
  return new File([new Uint8Array(size)], localPath.split('/').pop() ?? localPath, { type: 'image/jpeg' });
}

function makeRecord(sessionId: string, i: number, state: FileRecord['state'] = 'pending'): FileRecord {
  const localPath = `file-${i}.jpg`;
  return {
    id: `${sessionId}::${localPath}`,
    sessionId,
    localPath,
    fileName: localPath,
    relPathInBundle: localPath,
    sanitizedObjectName: localPath,
    size: 12,
    sha256: `sha-${i}`,
    captureTimestamp: '2026-07-01T12:00:00',
    mediaKind: 'image',
    mimeType: 'image/jpeg',
    state,
    remoteKey: `Collections/c/Uploads/u/${localPath}`,
    attempt: 0,
  };
}

function makeBundleRecord(sessionId: string): BundleRecord {
  return {
    sessionId,
    deploymentsCsv: 'deployments',
    mediaCsv: 'media',
    observationsCsv: 'observations',
    uploadMetaJson: '{"meta":true}',
    uploadCompleteJson: '{"complete":true}',
    metadataBundleSha256: 'bundle-sha',
  };
}

function makeBatch(sessionId: string, totalFiles: number): BatchRecord {
  return {
    id: sessionId,
    targetBucket: 'bucket',
    uploadPrefix: 'Collections/c/Uploads/u',
    deploymentId: 'deployment',
    location: LOCATION,
    uploaderUser: 'user',
    uploaderSlug: 'user',
    collectionUuid: 'collection',
    description: 'description',
    startedAt: '2026-07-23T00:00:00.000Z',
    totalFiles,
    totalBytes: totalFiles * 12,
    uploadTimeZone: 'UTC',
    fileAccessMode: 'reselect-required',
  };
}

function makeSession(states: FileRecord['state'][]): LoadedSession {
  const sessionId = 'session-1';
  return {
    batch: makeBatch(sessionId, states.length),
    bundle: makeBundleRecord(sessionId),
    files: states.map((state, i) => makeRecord(sessionId, i, state)),
  };
}

function attachedFor(records: FileRecord[]): Map<string, File> {
  return new Map(records.map((r) => [r.localPath, makeFile(r.localPath, r.size)]));
}

function makeFileEntry(i: number, size = 12): FileEntry {
  const relPath = `file-${i}.jpg`;
  return {
    id: relPath,
    file: makeFile(relPath, size),
    relPath,
    fileName: relPath,
    size,
    mediaKind: 'image',
    processState: 'ready',
    sha256: `sha-${i}`,
    exifNaive: { year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0 },
    mimeType: 'image/jpeg',
  };
}

function makeClient(records: FileRecord[], failingKeys = new Set<string>()): FakeClient {
  const byKey = new Map(records.map((r) => [r.remoteKey, r]));
  return {
    statObject: vi.fn(async (_bucket: string, key: string) => {
      const r = byKey.get(key);
      if (!r) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { size: r.size, metadata: { sha256: r.sha256 } };
    }),
    writeImmutableStream: vi.fn(async (_bucket: string, key: string) => {
      if (failingKeys.has(key)) throw badRequest();
      return { etag: `etag-${key}` };
    }),
    writeImmutable: vi.fn(async () => undefined),
    listObjects: vi.fn(async function* () {
      for (const r of records) yield { key: r.remoteKey, size: r.size };
    }),
  };
}

// Unlike makeClient, doesn't need to know exact keys upfront — a streamed
// run's keys depend on a real timestamp stamp, not a fixture. Matches a
// failing file by whether the key ends with its relPath, and derives the
// post-write stat from what was actually written (opts.sha256, file.size).
function makeStreamingClient(
  failingRelPaths = new Set<string>(),
  hooks: { onPut?: () => Promise<void>; omitFromListing?: (key: string) => boolean } = {},
): FakeClient {
  const written = new Map<string, { size: number; sha256: string }>();
  return {
    statObject: vi.fn(async (_bucket: string, key: string) => {
      const w = written.get(key);
      if (!w) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { size: w.size, metadata: { sha256: w.sha256 } };
    }),
    writeImmutableStream: vi.fn(async (_bucket: string, key: string, file: File, opts: { sha256: string }) => {
      if ([...failingRelPaths].some((p) => key.endsWith(p))) throw badRequest();
      if (hooks.onPut) await hooks.onPut();
      written.set(key, { size: file.size, sha256: opts.sha256 });
      return { etag: `etag-${key}` };
    }),
    writeImmutable: vi.fn(async () => undefined),
    listObjects: vi.fn(async function* () {
      for (const [key, w] of written) {
        if (hooks.omitFromListing?.(key)) continue;
        yield { key, size: w.size };
      }
    }),
  };
}

function holdMetadataUntilAborted(client: FakeClient): void {
  client.writeImmutable.mockImplementation(
    async (_bucket: string, _key: string, _body: string, opts: { signal?: AbortSignal }) =>
      new Promise<void>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (opts.signal?.aborted) abort();
        else opts.signal?.addEventListener('abort', abort, { once: true });
      }),
  );
}

async function collect(run: { done: Promise<void> }, onDone: () => UploadSnapshot | null): Promise<UploadSnapshot> {
  await run.done;
  const snap = onDone();
  expect(snap).not.toBeNull();
  return snap!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client = null;
});

describe('cancellation during metadata publication', () => {
  it('aborts a resumed run metadata PUT and never publishes the remaining files', async () => {
    const session = makeSession(['done']);
    const client = makeClient(session.files);
    holdMetadataUntilAborted(client);
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: new Map(), concurrency: manual(1) },
      (snap) => {
        last = snap;
      },
    );
    await vi.waitFor(() => expect(client.writeImmutable).toHaveBeenCalledTimes(1));
    run.cancel();
    const snap = await collect(run, () => last);

    expect(snap.error).toBe('cancelled');
    expect(client.writeImmutable).toHaveBeenCalledTimes(1);
    expect(client.writeImmutable.mock.calls[0][3].signal.aborted).toBe(true);
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });

  it('aborts a streamed run metadata PUT and never publishes the remaining files', async () => {
    const entries = [makeFileEntry(0)];
    const client = makeStreamingClient();
    holdMetadataUntilAborted(client);
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(1),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: entries,
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.close(entries);
    await vi.waitFor(() => expect(client.writeImmutable).toHaveBeenCalledTimes(1));
    run.cancel();
    const snap = await collect(run, () => last);

    expect(snap.error).toBe('cancelled');
    expect(client.writeImmutable).toHaveBeenCalledTimes(1);
    expect(client.writeImmutable.mock.calls[0][3].signal.aborted).toBe(true);
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });
});

describe('upload runs continue past per-file blob failures', () => {
  it('leaves a partial run open and skips metadata when some files fail', async () => {
    const session = makeSession(Array.from({ length: 6 }, () => 'pending'));
    const failing = new Set([session.files[1].remoteKey!, session.files[4].remoteKey!]);
    mocks.client = makeClient(session.files, failing);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(3) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    expect(snap.files.filter((f) => f.state === 'failed')).toHaveLength(2);
    expect(snap.files.filter((f) => f.state === 'done')).toHaveLength(4);
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });

  it('treats the per-file failure threshold as systemic', async () => {
    const session = makeSession(Array.from({ length: 15 }, () => 'pending'));
    mocks.client = makeClient(session.files, new Set(session.files.map((f) => f.remoteKey!)));
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(4) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(snap.error).toMatch(/file failures/);
  });

  it('aborts immediately on systemic access failures', async () => {
    expect(new PreconditionFailedError('x')).toBeInstanceOf(Error);
    const session = makeSession(Array.from({ length: 3 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    mocks.client.writeImmutableStream.mockRejectedValueOnce(forbidden());
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(1) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
  });

  it('retries a 403 with no readable reason instead of aborting immediately', async () => {
    const session = makeSession(Array.from({ length: 1 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    mocks.client.writeImmutableStream.mockRejectedValueOnce(unknownError403());
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(1) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.client.writeImmutableStream).toHaveBeenCalledTimes(2);
  });

  it('waits for reconnect instead of spending a retry attempt while offline', async () => {
    // Node's test environment has no `window`; stub a minimal one so the
    // offline-wait branch (guarded on `typeof window !== 'undefined'`) is
    // actually reachable here, matching a real browser.
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const session = makeSession(Array.from({ length: 1 }, () => 'pending'));
      mocks.client = makeClient(session.files);
      let last: UploadSnapshot | null = null;

      const run = resumeUpload(
        { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(1) },
        (snap) => {
          last = snap;
        },
      );

      // Give the lane a moment to reach the offline-wait branch — it should
      // sit there rather than attempting (or failing) anything.
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.client.writeImmutableStream).not.toHaveBeenCalled();

      vi.stubGlobal('navigator', { onLine: true });
      fakeWindow.dispatchEvent(new Event('online'));

      const snap = await collect(run, () => last);
      expect(snap.phase).toBe('done');
      expect(mocks.client.writeImmutableStream).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('waits for reconnect before the resume verify pass too, not just the upload retry loop', async () => {
    // A `doneAlready` file's first network call is `statObject` (verify),
    // not `writeImmutableStream` — the offline wait has to guard that call
    // too, or a resume started offline burns a lane failure on it before
    // ever reaching the retry loop's own check.
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const session = makeSession(['done']);
      mocks.client = makeClient(session.files);
      let last: UploadSnapshot | null = null;

      const run = resumeUpload(
        { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(1) },
        (snap) => {
          last = snap;
        },
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.client.statObject).not.toHaveBeenCalled();

      vi.stubGlobal('navigator', { onLine: true });
      fakeWindow.dispatchEvent(new Event('online'));

      const snap = await collect(run, () => last);
      expect(snap.phase).toBe('done');
      // The verify HEAD, then the final review's digest sample of the one file.
      expect(mocks.client.statObject).toHaveBeenCalledTimes(2);
      expect(mocks.client.writeImmutableStream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('unblocks a retrying offline lane immediately when the systemic abort fires', async () => {
    // Regression for #69. The scenario:
    //   1. Two lanes start online. File 0 hits a transient error and goes to
    //      sleep(backoff) before its next attempt. File 1 hits a run-fatal
    //      forbidden error, which makes the supervisor call abort.abort() —
    //      without setting `cancelled`.
    //   2. The network drops while file 0 is sleeping.
    //   3. File 0 wakes, calls ensureOnline(). It sees onLine===false and
    //      abort.signal.aborted===true (systemic abort, not user cancel).
    //   With the fix: ensureOnline throws immediately at the aborted check.
    //   Without: it called waitForOnline with an already-fired signal — the
    //   abort listener was registered too late, the poll timer (30 s) was the
    //   only escape, so the run hung until that tick.
    vi.useFakeTimers();
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { onLine: true });
    try {
      const session = makeSession(['pending', 'pending']);
      const f0key = session.files[0].remoteKey!;
      mocks.client = makeClient(session.files);
      mocks.client.writeImmutableStream.mockImplementation(async (_bucket: string, key: string) => {
        if (key === f0key) {
          // Transient server error: lane retries via sleep(backoff).
          throw Object.assign(new Error('service unavailable'), { $metadata: { httpStatusCode: 503 } });
        }
        // Run-fatal: supervisor triggers abort.abort() without setting cancelled.
        throw forbidden();
      });
      let last: UploadSnapshot | null = null;
      const run = resumeUpload(
        { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(2) },
        (snap) => { last = snap; },
      );
      // Flush microtasks: both lanes have attempted their writes. File 1's
      // forbidden has propagated to the supervisor, which called abort.abort().
      // File 0's lane is now sleeping in backoff (setTimeout, frozen by fake
      // timers). abort.signal.aborted is true; cancelled is false.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // Go offline before the sleeping lane wakes and calls ensureOnline.
      vi.stubGlobal('navigator', { onLine: false });
      // Advance the fake clock: file 0's backoff sleep resolves, the lane
      // calls ensureOnline, which now sees onLine===false and
      // abort.signal.aborted===true and must throw rather than park in
      // waitForOnline indefinitely.
      // Use runAllTimersAsync so microtasks flush between timer firings —
      // synchronous runAllTimers would loop the supervisor interval (1 s) tens
      // of thousands of times before the test runner detects an infinite loop.
      await vi.runAllTimersAsync();
      const snap = await collect(run, () => last);
      expect(snap.phase).toBe('error');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('publishes metadata after a clean sweep', async () => {
    const session = makeSession(Array.from({ length: 2 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(2) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.client.writeImmutable.mock.calls.map((c) => c[1])).toEqual([
      'Collections/c/Uploads/u/deployments.csv',
      'Collections/c/Uploads/u/media.csv',
      'Collections/c/Uploads/u/observations.csv',
      'Collections/c/Uploads/u/UploadMeta.json',
      'Collections/c/Uploads/u/UploadComplete.json',
    ]);
    expect(mocks.markBatchComplete).toHaveBeenCalledTimes(1);
  });

  it('confirms a resumed run by one listing pass plus a digest sample, not a HEAD per file', async () => {
    const session = makeSession(Array.from({ length: 8 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      {
        config: CONFIG,
        session,
        attached: attachedFor(session.files),
        concurrency: manual(2),
      },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.client.writeImmutableStream).toHaveBeenCalledTimes(8);
    expect(mocks.client.listObjects).toHaveBeenCalledTimes(1);
    expect(mocks.client.statObject.mock.calls.map((c) => c[1])).toEqual([
      session.files[0].remoteKey,
      session.files[3].remoteKey,
      session.files[7].remoteKey,
    ]);
  });

  it('final review fails a file whose sampled object lost its sha256 metadata', async () => {
    const session = makeSession(Array.from({ length: 3 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    // A proxy that strips x-amz-meta-* on write: the listing still agrees on
    // every size, only the HEAD shows the digest contract is gone.
    mocks.client.statObject.mockImplementation(async (_bucket: string, key: string) => {
      const r = session.files.find((f) => f.remoteKey === key)!;
      return key === session.files[1].remoteKey
        ? { size: r.size, metadata: {} }
        : { size: r.size, metadata: { sha256: r.sha256 } };
    });
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(3) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    const failed = snap.files.filter((f) => f.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('digest contract broken');
    expect(snap.log.some((l) => l.text.includes('x-amz-meta-*'))).toBe(true);
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
  });

  it('final review fails files the listing contradicts', async () => {
    const session = makeSession(Array.from({ length: 3 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    // Listing reports file 1 truncated and file 2 missing entirely.
    mocks.client.listObjects.mockImplementation(async function* () {
      yield { key: session.files[0].remoteKey, size: session.files[0].size };
      yield { key: session.files[1].remoteKey, size: session.files[1].size - 1 };
    });
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      {
        config: CONFIG,
        session,
        attached: attachedFor(session.files),
        concurrency: manual(3),
      },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    expect(snap.files.filter((f) => f.state === 'failed')).toHaveLength(2);
    expect(snap.files.filter((f) => f.state === 'done')).toHaveLength(1);
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
  });

  it('retries only failed or pending files and then completes', async () => {
    const session = makeSession(['done', 'done', 'done', 'done', 'failed', 'pending']);
    mocks.client = makeClient(session.files);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(3) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.client.writeImmutableStream).toHaveBeenCalledTimes(2);
    expect(mocks.client.writeImmutableStream.mock.calls.map((c) => c[1])).toEqual([
      session.files[4].remoteKey,
      session.files[5].remoteKey,
    ]);
    expect(mocks.client.writeImmutable).toHaveBeenCalledTimes(5);
  });


  it('refuses to publish on Retry after a file failed inspection, instead of resuming a short bundle', async () => {
    // The fresh run already refused to publish this batch. Retry hands the
    // persisted session to resumeUpload, whose bundle covers only the files
    // that were ready — so dropping the hashless row and publishing would make
    // exactly the short publish the fresh run refused, one click later.
    const sessionId = 'session-1';
    const ready = [makeRecord(sessionId, 0, 'pending'), makeRecord(sessionId, 1, 'pending')];
    // Shaped the way `close` leaves a file that failed Inspect after Start:
    // opened as awaiting-processing, patched to failed, still no hash or key.
    const failedInspect: FileRecord = {
      id: `${sessionId}::file-2.jpg`,
      sessionId,
      localPath: 'file-2.jpg',
      fileName: 'file-2.jpg',
      relPathInBundle: 'file-2.jpg',
      size: 12,
      state: 'failed',
      lastError: 'unreadable EXIF',
      attempt: 0,
    };
    const session: LoadedSession = {
      batch: makeBatch(sessionId, 3),
      bundle: makeBundleRecord(sessionId),
      files: [...ready, failedInspect],
    };
    mocks.client = makeClient(ready);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(ready), concurrency: manual(2) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(snap.error).toContain('failed inspection');
    expect(snap.files.filter((f) => f.state === 'failed')).toHaveLength(1);
    // Nothing uploaded, nothing published, batch never marked complete.
    expect(mocks.client.writeImmutableStream).not.toHaveBeenCalled();
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });

  it('accounts verified skips as skipped rather than transferred bytes', async () => {
    const session = makeSession(['done', 'done', 'pending', 'pending']);
    mocks.client = makeClient(session.files);
    // Only a real transfer reports progress; the two 'done' files take the
    // verified-skip path and never reach the stream.
    mocks.client.writeImmutableStream.mockImplementation(
      async (
        _bucket: string,
        key: string,
        file: File,
        opts: { onProgress?: (loaded: number) => void },
      ) => {
        opts.onProgress?.(file.size);
        return { etag: `etag-${key}` };
      },
    );
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: manual(2) },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(snap.collectionUuid).toBe('collection');
    expect(snap.files.filter((f) => f.state === 'skipped')).toHaveLength(2);
    expect(snap.skippedBytes).toBe(session.files[0].size + session.files[1].size);
    expect(snap.uploadedBytes).toBe(session.files.reduce((n, f) => n + f.size, 0));
  });

  it('respawns lanes when a manual target rises mid-run', async () => {
    const session = makeSession(Array.from({ length: 6 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    let landed = 0;
    let inFlight = 0;
    let release!: () => void;
    const threeInFlight = new Promise<void>((r) => (release = r));
    // After the first file, every PUT parks until three are in flight at once —
    // so this run only finishes if the pool actually spawned the extra lanes.
    mocks.client.writeImmutableStream.mockImplementation(async (_bucket: string, key: string) => {
      if (landed === 0) {
        landed++;
        return { etag: `etag-${key}` };
      }
      inFlight++;
      if (inFlight >= 3) release();
      await threeInFlight;
      inFlight--;
      landed++;
      return { etag: `etag-${key}` };
    });
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      {
        config: CONFIG,
        session,
        attached: attachedFor(session.files),
        // One lane until the first file lands, then three: the pool has to
        // spawn the two extra lanes to honour the raised target.
        concurrency: { mode: 'manual', get: () => (landed > 0 ? 3 : 1) },
      },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(snap.files.every((f) => f.state === 'done')).toBe(true);
    expect(mocks.client.writeImmutableStream).toHaveBeenCalledTimes(6);
    expect(snap.lanes).toBe(3);
  });

});

describe('streamed runs upload as files individually become ready', () => {
  it('publishes once a file that arrives after start() via notifyReady finishes too', async () => {
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    // Only the first file is known/ready at start() — the second arrives
    // later, exactly like a file that's still mid-Inspect when Upload starts.
    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [entries[0], { ...entries[1], processState: 'processing', sha256: undefined }],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    run.notifyReady([entries[1]]);
    run.close([entries[0], entries[1]]);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(snap.collectionUuid).toBe('collection');
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(2);
    expect(mocks.attachBundle).toHaveBeenCalledTimes(1);
    expect(mocks.markBatchComplete).toHaveBeenCalledTimes(1);
  });

  it('persists a bundle for later retry even on partial failure, once every file is known', async () => {
    const entries = [makeFileEntry(0), makeFileEntry(1), makeFileEntry(2)];
    const client = makeStreamingClient(new Set([entries[1].relPath]));
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: entries,
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.close(entries);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    expect(snap.files.filter((f) => f.state === 'failed')).toHaveLength(1);
    expect(snap.files.filter((f) => f.state === 'done')).toHaveLength(2);
    // The bundle is built (and persisted) once the full batch is known, even
    // though this run failed — so a retry has a real ledger to resume from.
    expect(mocks.attachBundle).toHaveBeenCalledTimes(1);
    expect(client.writeImmutable).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });

  it('retires lanes parked on the queue when the concurrency target drops', async () => {
    // A lane can sit in `queue.next()` for as long as Inspect takes. If it only
    // checks the target before parking, a burst of newly-ready files wakes
    // every parked lane at once and they all upload — ignoring a target that
    // dropped while they waited.
    const entries = Array.from({ length: 7 }, (_, i) => makeFileEntry(i));
    let inFlight = 0;
    let maxInFlight = 0;
    const client = makeStreamingClient(new Set(), {
      onPut: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    });
    mocks.client = client;
    let target = 8;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: { mode: 'manual', get: () => target },
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [
            entries[0],
            ...entries.slice(1).map((e) => ({ ...e, processState: 'processing' as const, sha256: undefined })),
          ],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    // Eight lanes spawn; one takes the single ready file and seven park.
    await new Promise((r) => setTimeout(r, 20));
    target = 1;
    run.notifyReady(entries.slice(1));
    run.close(entries);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(7);
    expect(maxInFlight).toBe(1);
  });

  it('cancelling settles a run whose lanes are all parked on the queue', async () => {
    // Lanes wait in the queue between files, holding no request. `cancel()`
    // aborts the request controller, which says nothing to a lane that has no
    // request — so nothing woke them, the lane set never settled, and `done`
    // never resolved. The Cancel button left the run spinning forever.
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(4),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [entries[0], { ...entries[1], processState: 'processing', sha256: undefined }],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    // Let the one ready file land. Every lane is now parked and the queue is
    // still open — exactly the state a user cancels from mid-batch.
    await new Promise((r) => setTimeout(r, 20));
    run.cancel();
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(snap.error).toBe('cancelled');
    expect(client.writeImmutable).not.toHaveBeenCalled();
  });

  it('a run-fatal blob error settles a run whose remaining lanes are parked', async () => {
    // The same hang reached from the other side: one lane hits a 403 while its
    // siblings wait on the queue for files Inspect will never deliver.
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    client.writeImmutableStream.mockImplementation(async () => {
      throw forbidden();
    });
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(4),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [entries[0], { ...entries[1], processState: 'processing', sha256: undefined }],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    // The queue is never closed, so the surviving lanes are parked on it when
    // the fatal error lands.
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(snap.error).toContain('forbidden');
    expect(client.writeImmutable).not.toHaveBeenCalled();
  });

  it('fails the run when a file errors in Inspect after start, instead of publishing a short batch', async () => {
    // The file is still processing at start(), so it is never enqueued, and it
    // then fails Inspect. `buildBundle` drops it from the CSVs, so a run that
    // ignored it would publish a smaller batch and call it done.
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [entries[0], { ...entries[1], processState: 'processing', sha256: undefined }],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    run.close([
      entries[0],
      { ...entries[1], processState: 'error', sha256: undefined, processError: 'unreadable EXIF' },
    ]);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    const failed = snap.files.filter((f) => f.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('unreadable EXIF');
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(1);
    expect(client.writeImmutable).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });

  it('picks up a ready file whose notifyReady never arrived, rather than dropping it', async () => {
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [entries[0], { ...entries[1], processState: 'processing', sha256: undefined }],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    // No notifyReady for the second file — close() carries the only word that
    // it ever became ready, and both files must still land.
    run.close(entries);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(2);
  });

  it('never writes a file row before the session row it belongs to', async () => {
    // `openSession` deletes and re-writes every row for the session, so a
    // `markFileState` that lands first is dropped (Dexie ignores an update to
    // a row that is not there yet) and then overwritten by the bulk put: the
    // blob really uploaded, but History would show it pending forever.
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    let openSessionDone!: () => void;
    mocks.openSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          openSessionDone = () => resolve();
        }),
    );
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: entries,
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.close(entries);

    // Transfers do not wait on the ledger — only the ledger writes do.
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.openSession).toHaveBeenCalledTimes(1);
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(2);
    expect(mocks.markFileState).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();

    openSessionDone();
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.markFileState).toHaveBeenCalled();
    expect(mocks.markBatchComplete).toHaveBeenCalledTimes(1);
  });

  it('serializes ledger writes so two updates to one file cannot reorder', async () => {
    // Both updates for a file (pending, then done) used to hang off the same
    // resolved promise, so they raced into IndexedDB and the row could settle
    // on whichever landed last rather than whichever was written last.
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    const client = makeStreamingClient();
    mocks.client = client;
    const events: string[] = [];
    let seq = 0;
    mocks.markFileState.mockImplementation(async () => {
      const n = seq++;
      events.push(`start:${n}`);
      // Alternating delays: fanned-out writes would finish out of order.
      await new Promise((r) => setTimeout(r, n % 2 === 0 ? 6 : 1));
      events.push(`end:${n}`);
    });
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: entries,
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.close(entries);
    const snap = await collect(run, () => last);
    mocks.markFileState.mockReset();

    expect(snap.phase).toBe('done');
    expect(events.length).toBeGreaterThanOrEqual(4);
    // Never two starts without the intervening end: a strict serial queue.
    const expected = events
      .filter((e) => e.startsWith('start:'))
      .flatMap((e) => [e, `end:${e.slice('start:'.length)}`]);
    expect(events).toEqual(expected);
    // And the completion stamp lands after every per-file write.
    expect(mocks.markBatchComplete).toHaveBeenCalledTimes(1);
  });

  it('reports a resume ledger that could not be opened, without failing the upload', async () => {
    const entries = [makeFileEntry(0)];
    const client = makeStreamingClient();
    mocks.client = client;
    mocks.openSession.mockImplementationOnce(() => Promise.reject(new Error('QuotaExceededError')));
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: entries,
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.close(entries);
    const snap = await collect(run, () => last);

    // The remote upload is still valid, so the run completes...
    expect(snap.phase).toBe('done');
    expect(client.writeImmutable).toHaveBeenCalledTimes(5);
    // ...but the run log says the batch will not be in History or resumable.
    const warned = snap.log.find((l) => l.text.includes('could not open the resume ledger'));
    expect(warned).toBeDefined();
    expect(warned!.text).toContain('QuotaExceededError');
  });

  it('confirms a streamed run by one listing pass, with no per-file HEAD', async () => {
    const entries = [makeFileEntry(0), makeFileEntry(1), makeFileEntry(2)];
    const client = makeStreamingClient();
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(2),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [entries[0], ...entries.slice(1).map((e) => ({ ...e, processState: 'processing' as const, sha256: undefined }))],
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.notifyReady(entries.slice(1));
    run.close(entries);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(3);
    // One listing for the whole batch, plus the digest sample — not a HEAD per
    // file during the run.
    expect(client.listObjects).toHaveBeenCalledTimes(1);
    expect(client.statObject.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('fails a streamed run whose final review listing cannot find an object', async () => {
    const entries = [makeFileEntry(0), makeFileEntry(1)];
    let missing: string | null = null;
    const client = makeStreamingClient(new Set(), {
      omitFromListing: (key) => {
        if (missing === null) missing = key; // drop whichever landed first
        return key === missing;
      },
    });
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(1),
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: entries,
        },
      },
      (snap) => {
        last = snap;
      },
    );
    run.close(entries);
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    const failed = snap.files.filter((f) => f.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('final review');
    expect(client.writeImmutable).not.toHaveBeenCalled();
  });

  it('publishes after the queue genuinely empties and every lane is parked waiting', async () => {
    // Regression test: with concurrency > the number of items enqueued so
    // far, every lane blocks on the same underlying queue at once. A queue
    // that only remembers a single waiter silently orphans every lane but
    // the last, and the run hangs forever instead of ever publishing — this
    // only surfaces when there's a real gap between "queue empties" and
    // "more work arrives", which a synchronous enqueue-then-close never
    // exercises. Real setTimeout delays force that gap here.
    const entries = [makeFileEntry(0), makeFileEntry(1), makeFileEntry(2)];
    const client = makeStreamingClient();
    mocks.client = client;
    let last: UploadSnapshot | null = null;

    const run = runStreamingUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: manual(4), // more lanes than the single file enqueued at start()
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: LOCATION,
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [
            entries[0],
            { ...entries[1], processState: 'processing', sha256: undefined },
            { ...entries[2], processState: 'processing', sha256: undefined },
          ],
        },
      },
      (snap) => {
        last = snap;
      },
    );

    // Let the first file finish and drain — every lane should now be parked.
    await new Promise((r) => setTimeout(r, 20));
    run.notifyReady([entries[1]]);
    await new Promise((r) => setTimeout(r, 20));
    run.notifyReady([entries[2]]);
    await new Promise((r) => setTimeout(r, 20));
    run.close(entries);

    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(client.writeImmutableStream).toHaveBeenCalledTimes(3);
    expect(mocks.markBatchComplete).toHaveBeenCalledTimes(1);
  });
});
