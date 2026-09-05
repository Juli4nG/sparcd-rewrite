// The hand-off record between the uploader and the tagger — one not-yet-uploaded
// local batch, handed over for species tagging and handed back with tags.
//
// Both tools deploy under the same origin in production
// (`/sparcd-exploration/uploader/` and `.../tagger/`), so a shared IndexedDB
// database is the transport: the uploader writes a record and navigates, the
// tagger opens it by id, writes tags back into the same row, and navigates home.
// Nothing leaves the browser, so a batch can be tagged with no connection at all.
//
// Blobs (the 64px thumbnails) and a `FileSystemDirectoryHandle` are stored
// directly — IndexedDB structured-clones both, which is the whole reason this
// is a Dexie store and not a query string.
//
// Schema versioning follows the two apps' rule: Dexie's versioning API with
// forward-carrying upgrade callbacks. v1 is the initial schema.

import Dexie, { type Table } from 'dexie';

/** One species applied to one image. Structurally identical to the tagger's
 *  `DraftObservation` and deliberately duplicated — the two apps stay
 *  independent, and this shape is the wire contract between them. */
export type FlipObservation = {
  scientificName: string;
  commonName: string;
  count: number;
  requestedSpecies: string;
  freeTags: string;
};

/**
 * One file in the handed-over batch. `relPath` is the uploader's scan id — the
 * path within the chosen folder — and is unique within a batch, so it doubles
 * as the tag key and the tagger's media key.
 *
 * Everything Inspect established rides along, not just what the tagger needs to
 * draw a tile: the batch is rebuilt from this record on the way back, and a
 * field that didn't travel is a field the uploader has to do without. Most of
 * it is display-only, but `mimeType` reaches `media.csv`, so a batch that went
 * through the tagger would otherwise publish differently from the same batch
 * uploaded straight through.
 */
export interface FlipFile {
  relPath: string;
  fileName: string;
  size: number;
  sha256: string;
  mediaKind: 'image' | 'video';

  // Capture time, naive wall-clock `YYYY-MM-DDTHH:mm:ss` with no zone applied.
  // The two sources stay apart: the uploader shows and offers different things
  // for a time the camera wrote than for one a person entered, so a manual time
  // must not come home looking like EXIF.
  /** The camera's own capture time, from EXIF or the video container. */
  exifTimestamp?: string;
  /** A capture time entered by hand for a file the camera left blank. */
  manualTimestamp?: string;
  estimatedTimestamp?: string;
  timestampSource?: 'manual' | 'spread' | 'interpolated' | 'offset' | 'file-modified';

  /** The worker's own sniff of the media type — authoritative over the file
   *  extension, and the value that lands in `media.csv`. */
  mimeType?: string;
  exifCamera?: string;
  gps?: { lat: number; lon: number };
  width?: number;
  height?: number;

  thumb?: Blob; // the 64px thumbnail the uploader already computed
}

/**
 * The one capture time to display for a file: the camera's own, else the one
 * entered by hand. Mirrors how the uploader resolves it at bundle build, so the
 * tagger shows the same value the upload will carry.
 */
export const captureTimestampOf = (file: FlipFile): string | undefined =>
  file.exifTimestamp ?? file.manualTimestamp ?? file.estimatedTimestamp;

export interface FlipRecord {
  id: string;
  /** Schema version. A record this build does not understand is treated as
   *  absent rather than guessed at, so a future v2 can never be misread. */
  v: 1;
  createdAt: string; // ISO; drives the pruning sweep below
  returnUrl: string; // where the tagger sends the user back to
  /** Present when the browser granted a durable folder handle. Its presence is
   *  the only thing anything branches on — no handle means thumbnails only,
   *  and the folder has to be chosen again on the way back. */
  dirHandle?: FileSystemDirectoryHandle;
  files: FlipFile[];
  tags: Record<string, FlipObservation[]>; // keyed by relPath; `[]` means detagged
  taggerUser?: string;
}

class FlipDb extends Dexie {
  records!: Table<FlipRecord, string>;

  constructor() {
    super('sparcd-flip');
    this.version(1).stores({ records: 'id' });
  }
}

export const flipDb = new FlipDb();

export const newFlipId = (): string => crypto.randomUUID();

/**
 * Merge a partial tag map over the stored one. Only the images the partial
 * mentions change, so a debounced per-image save can never clobber tags for
 * images it wasn't carrying. An empty array is a real value — the image was
 * deliberately detagged — not an absence.
 */
export function mergeTags(
  existing: Record<string, FlipObservation[]>,
  partial: Record<string, FlipObservation[]>,
): Record<string, FlipObservation[]> {
  return { ...existing, ...partial };
}

export async function writeFlipRecord(record: FlipRecord): Promise<void> {
  await flipDb.records.put(record);
}

/**
 * Read a record this build understands. A row stamped with a schema version
 * this build has never seen is reported absent rather than half-read: both
 * tools already have an honest "no such batch" state, and a v2 record read as
 * a v1 one would silently lose or misplace whatever v2 added.
 */
export async function readFlipRecord(id: string): Promise<FlipRecord | undefined> {
  const rec = await flipDb.records.get(id);
  return rec?.v === 1 ? rec : undefined;
}

export async function deleteFlipRecord(id: string): Promise<void> {
  await flipDb.records.delete(id);
}

/** How long an abandoned hand-off is kept. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Drop hand-offs nobody came back for. A record holds file paths, content
 * hashes, thumbnails and sometimes a live folder handle; the uploader deletes
 * one the moment its batch publishes, so what this sweeps up is the batches
 * that were started and abandoned. Without it the store only ever grows.
 *
 * A full scan, because `createdAt` is not indexed — the store holds one row per
 * hand-off a person has personally started, so there is nothing here worth an
 * index for.
 */
export async function pruneFlipRecords(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - MAX_AGE_MS).toISOString();
  return flipDb.records.filter((r) => r.createdAt < cutoff).delete();
}

// Sweep on first import, in both tools. Nothing waits on it and nothing depends
// on it having finished — an old record costs space, never correctness — so a
// failure here must not stop a batch from opening.
void pruneFlipRecords().catch(() => {});

/**
 * Merge tags for some images into the record. Runs inside a read-write
 * transaction so a debounced save and a whole-record write never interleave
 * into a lost update.
 */
export async function updateFlipTags(
  id: string,
  partial: Record<string, FlipObservation[]>,
): Promise<void> {
  await flipDb.transaction('rw', flipDb.records, async () => {
    const rec = await flipDb.records.get(id);
    if (!rec) return;
    await flipDb.records.put({ ...rec, tags: mergeTags(rec.tags, partial) });
  });
}

/** The tagger's final hand-back: merge the last tags, record who tagged. */
export async function finishFlipRecord(
  id: string,
  tags: Record<string, FlipObservation[]>,
  taggerUser: string,
): Promise<void> {
  await flipDb.transaction('rw', flipDb.records, async () => {
    const rec = await flipDb.records.get(id);
    if (!rec) return;
    await flipDb.records.put({ ...rec, tags: mergeTags(rec.tags, tags), taggerUser });
  });
}
