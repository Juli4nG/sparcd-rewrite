// Handing a not-yet-uploaded batch to the tagger, and taking it back.
//
// Out: everything the tagger needs to show and tag the batch offline — the
// per-file identity the uploader already computed, the thumbnails it already
// made, and (where the browser granted one) the folder handle that gets it
// full-resolution bytes. Then a same-tab navigation to the tagger.
//
// Back: `?flip=<id>` on the uploader's own URL. The record still holds every
// file's Inspect result, so the only thing that has to be recovered is the
// `File` objects themselves — a browser reload drops those and nothing else.
// `restoreFromHandleTrusted` reattaches them by path + size without re-hashing;
// the batch was persisted minutes ago in this same session, so re-proving its
// hashes would cost seconds to learn something the session never stopped knowing.

import {
  newFlipId,
  readFlipRecord,
  writeFlipRecord,
  type FlipFile,
  type FlipRecord,
} from '@sparcd/flip';
import { useStore, type FileEntry } from '../store';
import { restoreFromHandleTrusted } from './resume';
import { formatNaive } from './exifTime';
import { estimateCaptureTimes, type CaptureEstimate } from './estimateCaptureTime';
import { taggerBatchUrl, uploaderReturnUrl } from './siblings';

/** The flip id on this page load, if the tagger just sent the user back. */
export const returningFlipId = (): string | null =>
  new URLSearchParams(window.location.search).get('flip');

// Everything Inspect established travels, because the batch is rebuilt from
// this on the way back and there is no second Inspect pass to recover a field
// that didn't. Most of it only feeds the file list, but `mimeType` is the
// worker's own sniff and lands in media.csv — drop it and `mimeFor` falls back
// to the extension, so a batch that went through the tagger would publish
// different bytes from the same batch uploaded straight through.
const toFlipFile = (f: FileEntry, estimate: CaptureEstimate | undefined): FlipFile => ({
  relPath: f.relPath,
  fileName: f.fileName,
  size: f.size,
  sha256: f.sha256!,
  mediaKind: f.mediaKind,
  // Both wall-clocks, unconverted and kept apart. The upload zone is applied
  // later, at bundle build; and Inspect shows a camera time as read-only fact
  // but an entered time as the user's own correction, so collapsing the two
  // would bring a manual entry home disguised as EXIF.
  exifTimestamp: f.exifNaive ? formatNaive(f.exifNaive) : undefined,
  manualTimestamp: f.manualNaive ? formatNaive(f.manualNaive) : undefined,
  estimatedTimestamp: estimate ? formatNaive(estimate.naive) : undefined,
  timestampSource: f.exifNaive ? undefined : f.manualNaive ? f.manualSource ?? 'manual' : estimate?.method,
  mimeType: f.mimeType,
  exifCamera: f.exifCamera,
  gps: f.gps,
  width: f.width,
  height: f.height,
  thumb: f.thumbnail,
});

/**
 * Write the hand-off record for the current batch and navigate to the tagger.
 * Only files that finished Inspect travel: a file with no hash has no stable
 * identity to tag against, and the button is gated on a batch with no blocking
 * errors anyway.
 */
export async function handOffToTagger(): Promise<void> {
  const s = useStore.getState();
  const id = newFlipId();
  const estimates = estimateCaptureTimes(s.files, s.uploadTimeZone);
  await writeFlipRecord({
    id,
    v: 1,
    createdAt: new Date().toISOString(),
    returnUrl: uploaderReturnUrl(id),
    dirHandle: s.dirHandle ?? undefined,
    files: s.files.filter((f) => f.processState === 'ready' && f.sha256).map((f) => toFlipFile(f, estimates.get(f.id))),
    tags: {},
  });
  window.location.href = taggerBatchUrl(id);
}

/** Re-enter the same tagging session — drafts live tagger-side, so it resumes. */
export function reopenTagger(flipId: string): void {
  window.location.href = taggerBatchUrl(flipId);
}

const toFileEntry = (f: FlipFile, file: File, record: FlipRecord): FileEntry => ({
  id: f.relPath,
  file,
  relPath: f.relPath,
  fileName: f.fileName,
  size: f.size,
  mediaKind: f.mediaKind,
  processState: 'ready',
  sha256: f.sha256,
  exifNaive: parseNaive(f.exifTimestamp),
  manualNaive: parseNaive(f.manualTimestamp),
  manualSource: f.timestampSource === 'manual' || f.timestampSource === 'spread' ? f.timestampSource : undefined,
  mimeType: f.mimeType,
  exifCamera: f.exifCamera,
  gps: f.gps,
  width: f.width,
  height: f.height,
  thumbnail: f.thumb,
  preTags: record.tags[f.relPath] ?? [],
});

// The inverse of `formatNaive` — the record carries the wall-clock as text, and
// the rest of the uploader works in components.
function parseNaive(iso: string | undefined): FileEntry['exifNaive'] {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}

export type FlipReturn =
  /** The record is gone — a different origin in dev, or cleared storage. */
  | { kind: 'not-found' }
  /** The folder handle needs a user gesture before it will hand back bytes. */
  | { kind: 'needs-gesture'; record: FlipRecord }
  /** No durable handle rode along; the folder has to be chosen again. */
  | { kind: 'needs-reselect'; record: FlipRecord }
  | { kind: 'restored' };

/**
 * Load the returning batch and put the wizard back on Inspect.
 *
 * A page load is not a user gesture, so on Firefox and Safari — and on
 * Chromium once the grant has lapsed — `requestPermission` will refuse. That
 * is the `needs-gesture` result, and the caller renders a button whose click
 * calls straight back in here; that click IS the gesture, which is why the
 * permission call has to stay ahead of every other await (see
 * `restoreFromHandleTrusted`).
 */
export async function resumeFromFlip(flipId: string): Promise<FlipReturn> {
  const record = await readFlipRecord(flipId);
  if (!record) return { kind: 'not-found' };
  return adoptRecord(record);
}

/** The retry a "Reopen batch" click drives, with the record already in hand. */
export async function adoptRecord(record: FlipRecord): Promise<FlipReturn> {
  if (!record.dirHandle) return { kind: 'needs-reselect', record };

  const restore = await restoreFromHandleTrusted(
    { dirHandle: record.dirHandle },
    Promise.resolve(record.files.map((f) => ({ localPath: f.relPath, fileName: f.fileName, size: f.size }))),
  );
  if (!restore.ok) return { kind: 'needs-gesture', record };

  attach(record, restore.attached);
  return { kind: 'restored' };
}

/**
 * Adopt a batch whose folder the user just reselected. Same trusted matching as
 * the handle path — path and size — because the record's hashes were computed
 * from these very bytes minutes ago in this same session.
 */
export function adoptReselected(
  record: FlipRecord,
  scanned: { relPath: string; size: number; file: File }[],
): void {
  const byPath = new Map(scanned.map((f) => [f.relPath, f]));
  const attached = new Map<string, File>();
  for (const f of record.files) {
    const sf = byPath.get(f.relPath);
    if (sf && sf.size === f.size) attached.set(f.relPath, sf.file);
  }
  attach(record, attached);
}

// Files the folder no longer holds are dropped from the batch rather than
// carried as broken entries — the uploader has no bytes for them, so there is
// nothing honest to upload, and the count in the summary tells the user.
function attach(record: FlipRecord, attached: Map<string, File>): void {
  const files: FileEntry[] = [];
  for (const f of record.files) {
    const file = attached.get(f.relPath);
    if (file) files.push(toFileEntry(f, file, record));
  }
  useStore.getState().adoptTaggedBatch({
    flipId: record.id,
    files,
    dirHandle: record.dirHandle ?? null,
  });
}
