// The trusted restore path: reattach files from the stored directory handle by
// relPath + size, without re-running the hash pipeline.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchRecord, FileRecord } from '../src/lib/db';
import type { ProcessResponse } from '../src/lib/processPool';
import type { NaiveDateTime } from '../src/lib/exifTime';

// scanFiles.ts probes `window.showDirectoryPicker` at module load; resume.ts
// pulls it in. The node test environment has no `window`.
(globalThis as Record<string, unknown>).window ??= {};

const processBatch = vi.fn();
vi.mock('../src/lib/processPool', () => ({ processBatch }));
const attachBundle = vi.fn();
const updateFileRecords = vi.fn();
vi.mock('../src/lib/db', () => ({ attachBundle, updateFileRecords }));

let restoreFromHandleTrusted: typeof import('../src/lib/resume')['restoreFromHandleTrusted'];
let ensureBundle: typeof import('../src/lib/resume')['ensureBundle'];

beforeAll(async () => {
  ({ restoreFromHandleTrusted, ensureBundle } = await import('../src/lib/resume'));
});

// Minimal stand-ins for the File System Access API: jsdom has no real handles.
// A directory yields its entries from an async generator, exactly as
// `scanDirectoryHandle` consumes them.
type FakeEntry = { name: string; bytes: number };

function fileHandle(entry: FakeEntry) {
  return {
    kind: 'file' as const,
    name: entry.name,
    getFile: async () => new File([new Uint8Array(entry.bytes)], entry.name, { type: 'image/jpeg' }),
  };
}

function dirHandle(
  name: string,
  entries: FakeEntry[],
  permission: { query: PermissionState; request?: PermissionState } = { query: 'granted' },
): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    values: async function* () {
      for (const e of entries) yield fileHandle(e);
    },
    queryPermission: async () => permission.query,
    requestPermission: async () => permission.request ?? 'denied',
  } as unknown as FileSystemDirectoryHandle;
}

function batchWith(handle?: FileSystemDirectoryHandle): BatchRecord {
  return { id: 'session-1', dirHandle: handle } as unknown as BatchRecord;
}

function record(localPath: string, size: number): FileRecord {
  return {
    id: `session-1::${localPath}`,
    sessionId: 'session-1',
    localPath,
    fileName: localPath.split('/').pop()!,
    relPathInBundle: localPath,
    size,
    state: 'pending',
    attempt: 0,
    sha256: `sha-${localPath}`,
    captureTimestamp: '2026-07-01 12:00:00',
  };
}

describe('restoreFromHandleTrusted', () => {
  it('attaches every matching file without hashing', async () => {
    const handle = dirHandle('trip', [
      { name: 'IMG001.JPG', bytes: 64 },
      { name: 'IMG002.JPG', bytes: 32 },
    ]);
    const records = [record('trip/IMG001.JPG', 64), record('trip/IMG002.JPG', 32)];

    const res = await restoreFromHandleTrusted(batchWith(handle), Promise.resolve(records));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.attached.keys()]).toEqual(['trip/IMG001.JPG', 'trip/IMG002.JPG']);
    expect(res.attached.get('trip/IMG001.JPG')!.size).toBe(64);
    expect(res.problems).toEqual([]);
    expect(processBatch).not.toHaveBeenCalled();
  });

  it('ignores files on disk that no record mentions', async () => {
    const handle = dirHandle('trip', [
      { name: 'IMG001.JPG', bytes: 64 },
      { name: 'EXTRA.JPG', bytes: 64 },
    ]);

    const res = await restoreFromHandleTrusted(
      batchWith(handle),
      Promise.resolve([record('trip/IMG001.JPG', 64)]),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.attached.keys()]).toEqual(['trip/IMG001.JPG']);
    expect(res.problems).toEqual([]);
  });

  it('reports a size mismatch as a problem instead of attaching it', async () => {
    const handle = dirHandle('trip', [
      { name: 'IMG001.JPG', bytes: 64 },
      { name: 'IMG002.JPG', bytes: 99 },
    ]);
    const records = [record('trip/IMG001.JPG', 64), record('trip/IMG002.JPG', 32)];

    const res = await restoreFromHandleTrusted(batchWith(handle), Promise.resolve(records));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.attached.keys()]).toEqual(['trip/IMG001.JPG']);
    expect(res.problems).toEqual([
      { localPath: 'trip/IMG002.JPG', fileName: 'IMG002.JPG', reason: 'size differs (99 ≠ 32)' },
    ]);
  });

  it('reports a record with no file on disk as a problem', async () => {
    const handle = dirHandle('trip', [{ name: 'IMG001.JPG', bytes: 64 }]);
    const records = [record('trip/IMG001.JPG', 64), record('trip/GONE.JPG', 64)];

    const res = await restoreFromHandleTrusted(batchWith(handle), Promise.resolve(records));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.attached.keys()]).toEqual(['trip/IMG001.JPG']);
    expect(res.problems).toEqual([
      { localPath: 'trip/GONE.JPG', fileName: 'GONE.JPG', reason: 'not in the selected folder' },
    ]);
  });

  it('prompts when permission is not already granted, and walks once it is', async () => {
    const handle = dirHandle('trip', [{ name: 'IMG001.JPG', bytes: 64 }], {
      query: 'prompt',
      request: 'granted',
    });

    const res = await restoreFromHandleTrusted(
      batchWith(handle),
      Promise.resolve([record('trip/IMG001.JPG', 64)]),
    );

    expect(res.ok).toBe(true);
  });

  it('fails with the reselect reason when read permission is denied', async () => {
    const handle = dirHandle('trip', [{ name: 'IMG001.JPG', bytes: 64 }], {
      query: 'prompt',
      request: 'denied',
    });

    const res = await restoreFromHandleTrusted(
      batchWith(handle),
      Promise.resolve([record('trip/IMG001.JPG', 64)]),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'Read permission to the folder was not granted — reselect it instead.',
    });
  });

  it('fails when the session has no stored handle', async () => {
    const res = await restoreFromHandleTrusted(batchWith(undefined), Promise.resolve([]));
    expect(res).toEqual({
      ok: false,
      reason: 'No durable folder handle is stored for this session.',
    });
  });

  // The gesture-gated call has to happen before anything else is awaited, or
  // Firefox and Safari drop it silently. A records promise that never settles
  // pins that down: the prompt still has to fire.
  it('reaches the permission prompt without waiting on the records', async () => {
    const requested = vi.fn(async () => 'granted' as PermissionState);
    const handle = {
      kind: 'directory',
      name: 'trip',
      values: async function* () {
        yield fileHandle({ name: 'IMG001.JPG', bytes: 64 });
      },
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission: requested,
    } as unknown as FileSystemDirectoryHandle;

    let releaseRecords: (r: FileRecord[]) => void;
    const recordsPromise = new Promise<FileRecord[]>((resolve) => {
      releaseRecords = resolve;
    });

    const pending = restoreFromHandleTrusted(batchWith(handle), recordsPromise);
    await Promise.resolve();
    expect(requested).toHaveBeenCalledWith({ mode: 'read' });

    releaseRecords!([record('trip/IMG001.JPG', 64)]);
    const res = await pending;
    expect(res.ok).toBe(true);
  });
});

// A session interrupted before it ever reached publish: `ensureBundle` resolves
// what never finished Inspect and builds the bundle it never got. A file the
// camera never timed used to be a blocking problem here; now it is estimated
// from the batch's camera times, exactly as a fresh upload would.
describe('ensureBundle capture times', () => {
  const UUID = '8dbd9c43-5c3d-411d-8778-617d4693c69b';
  const batch = {
    id: 'session-1',
    location: { key: 'SAN15|31.5,-110.2', id: 'SAN15', name: 'San Pedro 15', latitude: 31.5, longitude: -110.2, elevation: 1200 },
    collectionUuid: UUID,
    targetBucket: `sparcd-${UUID}`,
    uploaderSlug: 'jdoe',
    description: 'july',
    uploadPrefix: `Collections/${UUID}/Uploads/2024.01.15.10.00.00_jdoe`,
    startedAt: '2024-01-15T10:00:00.000Z',
    uploadTimeZone: 'America/Phoenix',
  } as unknown as BatchRecord;

  const awaiting = (localPath: string): FileRecord => ({
    id: `session-1::${localPath}`,
    sessionId: 'session-1',
    localPath,
    fileName: localPath.split('/').pop()!,
    relPathInBundle: localPath,
    size: 64,
    state: 'awaiting-processing',
    attempt: 0,
  });

  const inspected = (localPath: string, exifNaive?: NaiveDateTime): ProcessResponse =>
    ({ id: localPath, sha256: `sha-${localPath}`, exifNaive, mediaKind: 'image', mimeType: 'image/jpeg' }) as ProcessResponse;

  const attachedFor = (paths: string[]) =>
    new Map(paths.map((p) => [p, new File([new Uint8Array(64)], p.split('/').pop()!)]));

  beforeEach(() => {
    attachBundle.mockClear();
    updateFileRecords.mockClear();
  });

  it('keeps a record that already carries a capture time, with its source', async () => {
    const files: FileRecord[] = [
      { ...awaiting('t/IMG_0001.JPG'), state: 'pending', sha256: 'sha-1', remoteKey: `${batch.uploadPrefix}/IMG_0001.JPG`, captureTimestamp: '2024-01-10T15:00:00.000Z' },
      { ...awaiting('t/IMG_0002.JPG'), state: 'pending', sha256: 'sha-2', remoteKey: `${batch.uploadPrefix}/IMG_0002.JPG`, captureTimestamp: '2024-01-10T15:30:00.000Z', timestampSource: 'manual' },
    ];
    const res = await ensureBundle(batch, { bundle: null, files }, new Map(), attachedFor(files.map((f) => f.localPath)));
    expect(res.ok).toBe(true);
    const csv = attachBundle.mock.calls[0][0].mediaCsv as string;
    expect(csv).toContain('2024-01-10T15:00:00.000Z');
    expect(csv).toContain('2024-01-10T15:30:00.000Z');
    expect(csv).toContain('[TIMESTAMP:manual]');
  });

  // History lets an already-uploaded file be missing from the folder, so a
  // batch where nothing carries a camera time must not go looking for its
  // modified time to estimate from — it already published a time, and keeps it.
  it('keeps the published time of a done file that is no longer on disk', async () => {
    const files: FileRecord[] = [
      { ...awaiting('t/IMG_0001.JPG'), state: 'done', sha256: 'sha-1', remoteKey: `${batch.uploadPrefix}/IMG_0001.JPG`, captureTimestamp: '2024-01-10T15:00:00.000Z', timestampSource: 'file-modified' },
      { ...awaiting('t/IMG_0002.JPG'), state: 'pending', sha256: 'sha-2', remoteKey: `${batch.uploadPrefix}/IMG_0002.JPG`, captureTimestamp: '2024-01-10T15:10:00.000Z', timestampSource: 'file-modified' },
    ];

    const res = await ensureBundle(batch, { bundle: null, files }, new Map(), attachedFor(['t/IMG_0002.JPG']));

    expect(res.ok).toBe(true);
    const csv = attachBundle.mock.calls[0][0].mediaCsv as string;
    expect(csv).toContain('2024-01-10T15:00:00.000Z');
    expect(csv).toContain('[TIMESTAMP:file-modified]');
  });

  it('estimates a capture time for a file the camera never timed, instead of refusing to resume', async () => {
    const files = [awaiting('t/IMG_0001.JPG'), awaiting('t/IMG_0002.JPG'), awaiting('t/IMG_0003.JPG')];
    const at = (hour: number, minute: number): NaiveDateTime => ({ year: 2024, month: 1, day: 10, hour, minute, second: 0 });
    const resolved = new Map([
      ['t/IMG_0001.JPG', inspected('t/IMG_0001.JPG', at(8, 0))],
      ['t/IMG_0002.JPG', inspected('t/IMG_0002.JPG')],
      ['t/IMG_0003.JPG', inspected('t/IMG_0003.JPG', at(8, 10))],
    ]);

    const res = await ensureBundle(batch, { bundle: null, files }, resolved, attachedFor(files.map((f) => f.localPath)));
    expect(res.ok).toBe(true);
    // Phoenix is UTC-7 year round: 08:05 local → 15:05Z, midway between its
    // two neighbours.
    const csv = attachBundle.mock.calls[0][0].mediaCsv as string;
    expect(csv).toContain('2024-01-10T15:05:00.000Z');
    expect(csv).toContain('[TIMESTAMP:interpolated]');
    const persisted = updateFileRecords.mock.calls[0][0] as FileRecord[];
    const gap = persisted.find((r) => r.localPath === 't/IMG_0002.JPG')!;
    expect(gap.timestampSource).toBe('interpolated');
    expect(gap.captureTimestamp).toBe('2024-01-10T15:05:00.000Z');
  });
});
