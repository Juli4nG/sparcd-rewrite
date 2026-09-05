// The local-batch counterpart to `workspace.ts`: where that joins canonical
// `media.csv` + `observations.csv` into per-image state, this projects the
// uploader's hand-off record into the same shape. Pure — everything downstream
// of `TagImage` is then identical for both modes.

import { captureTimestampOf, type FlipObservation, type FlipRecord } from '@sparcd/flip';
import type { DraftRecord } from './db';
import type { TagImage } from './workspace';

/**
 * The record as the Tag workspace sees it. Images key on their path within the
 * chosen folder — the uploader's scan id, unique per batch. There is no
 * deployment: the uploader assigns one after tagging, so nothing here can know it.
 */
export function localTagImages(record: FlipRecord): TagImage[] {
  return record.files.map((f) => ({
    key: f.relPath,
    fileName: f.fileName,
    deploymentId: '',
    mediaKind: f.mediaKind,
    // One time to show, whichever source it came from — the tagger only needs
    // the value; keeping the two apart is the uploader's concern.
    baseTimestamp: captureTimestampOf(f) ?? '',
    timestampSource: f.timestampSource,
    // Copied, not aliased — a draft seeded from this must never write through
    // into the record the uploader is going to read back.
    baseObservations: (record.tags[f.relPath] ?? []).map((o) => ({ ...o })),
  }));
}

/** Every draft's full intended species set, in the record's tag shape. */
export function tagsFromDrafts(
  drafts: Record<string, DraftRecord>,
): Record<string, FlipObservation[]> {
  const out: Record<string, FlipObservation[]> = {};
  for (const path in drafts) out[path] = drafts[path].observations;
  return out;
}
