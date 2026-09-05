// Joins the canonical `media.csv` + `observations.csv` into the per-image base
// state the Tag workspace edits on top of. `media.csv` is the authoritative
// image order and source of deployment + capture time; existing observation
// rows seed each image's "already-tagged" label so re-opening an upload shows
// prior work (from Java, sparcd-web, or an earlier tagger sync).

import {
  parseMedia,
  parseObservations,
  commonNameFromComments,
  requestedSpeciesFromComments,
  timestampSourceFromComments,
  type Observation,
  type TimestampSource,
} from '@sparcd/camtrap';
import type { DraftObservation } from './db';

/** The canonical CSV text `buildTagImages` reads (the sync path adds ETags/hashes). */
export type CanonicalBundle = {
  mediaCsv: string;
  observationsCsv: string;
};

/** One image as the Tag workspace sees it before any local edit. */
export type TagImage = {
  key: string; // media.csv col 0 = full object key (the presign + draft key)
  fileName: string;
  deploymentId: string;
  baseTimestamp: string; // media col 4, ISO
  /** Where col 4 came from when the camera wrote no time — the uploader's
   *  `[TIMESTAMP:…]` marker in media col 10. Absent for a camera-written time. */
  timestampSource?: TimestampSource;
  baseObservations: DraftObservation[]; // ALL canonical observation rows, in CSV order
  /** Known for a local batch, where the uploader's worker sniffed the bytes.
   *  Absent for a canonical record, whose `media.csv` gives us only the key. */
  mediaKind?: 'image' | 'video';
};

// `.jpg`/`.mp4` only — same definition of "taggable image" the readers use, so
// snapshot/CSV/JSON rows in media.csv (there are none today, but be defensive)
// never become tiles.
const IMAGE_EXT = /\.(jpe?g|mp4)$/i;

// A display-mode discriminator over keys that already passed `IMAGE_EXT`. Only
// `.mp4` actually reaches the UI today (it's the lone video ext `IMAGE_EXT`
// admits), but we match the other common camera-trap video extensions too so
// widening the listing filter later doesn't silently render a clip as a broken
// <img>. Detection is by key/filename extension only — no probing.
export function isVideoKey(key: string): boolean {
  return /\.(mp4|avi|mov|m4v)$/i.test(key);
}

/** Whether an image renders as video: the batch's own answer where there is
 *  one, else the extension — the only signal a canonical record carries. */
export function isVideoImage(image: TagImage): boolean {
  return image.mediaKind ? image.mediaKind === 'video' : isVideoKey(image.key);
}

export function buildTagImages(bundle: CanonicalBundle): TagImage[] {
  const obsByMedia = new Map<string, Observation[]>();
  for (const o of parseObservations(bundle.observationsCsv)) {
    const list = obsByMedia.get(o.mediaId);
    if (list) list.push(o);
    else obsByMedia.set(o.mediaId, [o]);
  }

  return parseMedia(bundle.mediaCsv)
    .filter((m) => IMAGE_EXT.test(m.mediaId))
    .map((m) => ({
      key: m.mediaId,
      fileName: m.fileName || (m.mediaId.split('/').pop() ?? m.mediaId),
      deploymentId: m.deploymentId,
      baseTimestamp: m.timestamp,
      timestampSource: timestampSourceFromComments(m.comments ?? '') ?? undefined,
      baseObservations: (obsByMedia.get(m.mediaId) ?? []).filter((o) => o.observationType === 'animal').map((o) => ({
        scientificName: o.scientificName,
        commonName: commonNameFromComments(o.tags) ?? '',
        count: o.count ?? 0, // parseObservations always yields a real number; 0 is the type-safe fallback
        requestedSpecies: requestedSpeciesFromComments(o.tags) ?? '',
        // Base free-tags aren't surfaced today; keep '' to match prior behaviour.
        freeTags: '',
      })),
    }));
}
