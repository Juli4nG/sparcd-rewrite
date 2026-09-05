// IndexedDB-backed upload-session state for resume (P5). Dexie owns the schema;
// the orchestrator writes a session here on every wet run and updates per-file
// state as blobs land, so a closed tab or a flaky connection can pick the batch
// back up instead of re-uploading from scratch.
//
// Dry runs never touch this store — they write nothing, so there is nothing to
// resume. Only wet uploads persist.
//
// Schema versioning follows the tagger's rule: Dexie's versioning API with
// forward-carrying upgrade callbacks, no ad-hoc store mutations. v1 is the
// initial schema; the `blobPrefix` field the plan originally sketched is gone —
// P3 put image bytes under the upload prefix, so there is no separate blob
// prefix to record.

import Dexie, { type Table } from 'dexie';
import type { FlipObservation } from '@sparcd/flip';
import type { MediaKind } from './scanFiles';
import type { Location } from './locations';

/**
 * How the source bytes are recovered on resume. `persistent-handle` means a
 * durable `FileSystemDirectoryHandle` is stored and the browser can re-grant
 * read access; `reselect-required` means the user must reselect the folder and
 * we reconcile by relative path, size, and SHA-256.
 */
export type FileAccessMode = 'persistent-handle' | 'reselect-required';

/**
 * Per-file persisted state. `uploading` collapses to a restart on resume.
 * `awaiting-processing` is a file that's part of the batch (scanned, its size
 * known) but hasn't finished the Inspect worker pipeline yet, so it has no
 * hash/object-key/capture-time to persist beyond its scanned identity —
 * streamed runs open a session with files in this state and fill the rest in
 * as Inspect catches up. Non-streamed resume (an already-complete batch) never
 * sees this state.
 */
export type PersistedFileState = 'awaiting-processing' | 'pending' | 'uploading' | 'done' | 'failed';

export interface BatchRecord {
  id: string; // sessionId — crypto.randomUUID, stable across resume
  targetBucket: string;
  uploadPrefix: string; // Collections/<uuid>/Uploads/<stamp>_<slug>
  deploymentId: string;
  // The full location, redundant with `deploymentId` (which only embeds
  // `location.id`) — kept so a bundle-less session (interrupted before
  // Inspect finished) can rebuild the metadata bundle on resume without a
  // fresh S3 fetch to re-resolve which location `deploymentId` meant.
  location: Location;
  uploaderUser: string; // raw identity (the slug is derived at point of use)
  uploaderSlug: string; // sanitized slug actually used in keys
  collectionUuid: string;
  description: string;
  startedAt: string; // ISO
  completedAt?: string; // ISO once UploadComplete.json lands
  totalFiles: number;
  totalBytes: number;
  uploadTimeZone: string; // IANA zone EXIF naive times were interpreted in
  fileAccessMode: FileAccessMode;
  // Structured-cloned into IndexedDB on Chromium when permission was granted;
  // absent when the access mode is `reselect-required`.
  dirHandle?: FileSystemDirectoryHandle;
}

export interface FileRecord {
  id: string; // `${sessionId}::${localPath}`
  sessionId: string;
  localPath: string; // path within the chosen folder (bundle-relative source)
  fileName: string;
  relPathInBundle: string; // sanitized relative path, pre-collision — known at scan time
  size: number; // known at scan time (File.size), before Inspect runs
  state: PersistedFileState;
  attempt: number;
  // The rest depend on this file's own Inspect pass and are absent while
  // `state === 'awaiting-processing'`; filled in the moment it finishes,
  // independent of whether any other file in the batch has.
  sanitizedObjectName?: string; // resolved object name (post-collision), key tail
  remoteKey?: string; // full key = uploadPrefix/sanitizedObjectName (= media_path)
  sha256?: string;
  timestampSource?: import('@sparcd/camtrap').TimestampSource;
  captureTimestamp?: string; // resolved naive-UTC capture time (post-tz), media.csv col 4
  exifCamera?: string;
  mediaKind?: MediaKind;
  mimeType?: string;
  remoteETag?: string;
  lastError?: string;
  // Species applied in the tagger before this batch was ever uploaded. Not
  // indexed, so it needs no schema bump; persisted so a batch interrupted days
  // after tagging still publishes the identifications it left with.
  preTags?: FlipObservation[];
}

export interface BundleRecord {
  sessionId: string;
  uploadMetaJson: string;
  deploymentsCsv: string;
  mediaCsv: string;
  observationsCsv: string;
  uploadCompleteJson: string;
  metadataBundleSha256: string;
}

class UploaderDb extends Dexie {
  batches!: Table<BatchRecord, string>;
  files!: Table<FileRecord, string>;
  bundles!: Table<BundleRecord, string>;

  constructor() {
    super('sparcd-uploader');
    this.version(1).stores({
      // Index `completedAt` so the resume scan can find open sessions cheaply.
      batches: 'id, completedAt',
      files: 'id, sessionId, state',
      bundles: 'sessionId',
    });
    // v2: per-upload timezone + video support. Indexes are unchanged (the new
    // fields aren't indexed), but the field shapes changed, so a forward-carrying
    // upgrade rewrites legacy in-flight rows. Legacy rows pre-date tz support:
    // their `exifTimestamp` was a browser-zone ISO; carry it verbatim as
    // `captureTimestamp` so a resume reproduces the prior bytes, and stamp UTC
    // as the upload zone so the bundle rebuild doesn't re-derive a different
    // instant. Default `mediaKind`/`mimeType` to image (the only legacy type).
    this.version(2)
      .stores({
        batches: 'id, completedAt',
        files: 'id, sessionId, state',
        bundles: 'sessionId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('files')
          .toCollection()
          .modify((f: Record<string, unknown>) => {
            if (f.captureTimestamp === undefined) f.captureTimestamp = f.exifTimestamp;
            delete f.exifTimestamp;
            if (f.mediaKind === undefined) f.mediaKind = 'image';
            if (f.mimeType === undefined) f.mimeType = 'image/jpeg';
          });
        await tx
          .table('batches')
          .toCollection()
          .modify((b: Record<string, unknown>) => {
            if (b.uploadTimeZone === undefined) b.uploadTimeZone = 'UTC';
          });
      });
  }
}

export const db = new UploaderDb();

export const fileRecordId = (sessionId: string, localPath: string): string =>
  `${sessionId}::${localPath}`;

/** All sessions, newest first — drives the History list. */
export async function listBatches(): Promise<BatchRecord[]> {
  const rows = await db.batches.toArray();
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Open (not-yet-completed) sessions — candidates for resume. */
export async function listResumable(): Promise<BatchRecord[]> {
  return (await listBatches()).filter((b) => !b.completedAt);
}

/** Per-state file tallies for a session — drives the History progress line. */
export async function fileStateCounts(
  sessionId: string,
): Promise<Record<PersistedFileState, number>> {
  const rows = await db.files.where('sessionId').equals(sessionId).toArray();
  const counts: Record<PersistedFileState, number> = {
    'awaiting-processing': 0,
    pending: 0,
    uploading: 0,
    done: 0,
    failed: 0,
  };
  for (const r of rows) counts[r.state]++;
  return counts;
}

export type LoadedSession = {
  batch: BatchRecord;
  // Null while the batch is still being discovered/inspected — the metadata
  // bundle doesn't exist yet because it needs the complete processed set.
  // Non-null once every file is known and the CSVs/UploadMeta.json have been
  // built, exactly as it always has been for a fully-known session.
  bundle: BundleRecord | null;
  files: FileRecord[];
};

export async function loadSession(sessionId: string): Promise<LoadedSession | null> {
  const [batch, bundle, files] = await Promise.all([
    db.batches.get(sessionId),
    db.bundles.get(sessionId),
    db.files.where('sessionId').equals(sessionId).toArray(),
  ]);
  if (!batch) return null;
  return { batch, bundle: bundle ?? null, files };
}

/**
 * Persist (or re-persist) a whole session, bundle included. The file rows are
 * replaced wholesale so a re-stamp — which rebuilds the bundle under a fresh
 * prefix and re-keys every file — leaves no stale rows behind for the same
 * `sessionId`. Used once the full bundle is known: the legacy fully-known-
 * upfront path, and the re-stamp retry after a prefix collision.
 */
export async function saveSession(
  batch: BatchRecord,
  bundle: BundleRecord,
  files: FileRecord[],
): Promise<void> {
  await db.transaction('rw', db.batches, db.bundles, db.files, async () => {
    await db.batches.put(batch);
    await db.bundles.put(bundle);
    await db.files.where('sessionId').equals(batch.id).delete();
    await db.files.bulkPut(files);
  });
}

/**
 * Open a session before the full batch is known: persist the batch shell and
 * every scanned file's identity (most starting `awaiting-processing`), with
 * no bundle row yet. `loadSession` on this id returns `bundle: null` until
 * `attachBundle` is called.
 */
export async function openSession(batch: BatchRecord, files: FileRecord[]): Promise<void> {
  await db.transaction('rw', db.batches, db.files, async () => {
    await db.batches.put(batch);
    await db.files.where('sessionId').equals(batch.id).delete();
    await db.files.bulkPut(files);
  });
}

/**
 * Attach the metadata bundle to an already-open session, once every file has
 * finished processing and the CSVs/UploadMeta.json can finally be built. From
 * this point `loadSession` behaves exactly as it always has.
 */
export async function attachBundle(bundle: BundleRecord): Promise<void> {
  await db.bundles.put(bundle);
}

export async function markFileState(id: string, patch: Partial<FileRecord>): Promise<void> {
  await db.files.update(id, patch);
}

/** Replace many file records at once (by primary key) — resolving a batch of
 * records that finished Inspect out-of-band (resume-before-bundle) in one
 * write instead of one `markFileState` transaction per file. */
export async function updateFileRecords(records: FileRecord[]): Promise<void> {
  await db.files.bulkPut(records);
}

export async function markBatchComplete(sessionId: string, completedAt: string): Promise<void> {
  await db.batches.update(sessionId, { completedAt });
}

/** Update the prefix-derived fields after a re-stamp (kept distinct from save). */
export async function updateBatch(sessionId: string, patch: Partial<BatchRecord>): Promise<void> {
  await db.batches.update(sessionId, patch);
}

/** Drop a session row plus its files and bundle. Never touches remote state. */
export async function discardSession(sessionId: string): Promise<void> {
  await db.transaction('rw', db.batches, db.files, db.bundles, async () => {
    await db.files.where('sessionId').equals(sessionId).delete();
    await db.bundles.delete(sessionId);
    await db.batches.delete(sessionId);
  });
}
