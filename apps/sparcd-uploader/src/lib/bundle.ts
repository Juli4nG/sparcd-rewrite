// In-memory Camtrap-DP bundle generation for the Assign-step preview. Pure
// (apart from Web Crypto for the integrity hash) and S3-free — it produces the
// exact byte payloads P4 will upload, so the preview is truthful.
//
// Layout decision (P3, verified): image blobs live UNDER the upload prefix,
// because the existing SPARC'd reader lists objects under that prefix and
// ignores `media.csv`'s media_path. So `media_path` is
// `Collections/<uuid>/Uploads/<stamp>_<slug>/<relpath>` — not a separate
// UploadBlobs key. See plan "Persistence — S3 sync".

import type { Media, Observation, TimestampSource } from '@sparcd/camtrap';
import {
  serializeDeployments,
  serializeMedia,
  serializeObservations,
  buildUploadMeta,
  serializeUploadMeta,
  serializeUploadComplete,
  uploadStamp,
  buildObservationComments,
  buildMediaComments,
  hasSpeciesPresent,
  parseTagMarkers,
  defaultObservationId,
  type UploadCompleteJson,
} from '@sparcd/camtrap';
import type { FlipObservation } from '@sparcd/flip';
import { locationToDeployment, type Location } from './locations';
import { sanitizeRelPath, nameCounts, resolveOneName } from './normalize';
import { naiveInZoneToUtcIso } from './exifTime';
import { estimateCaptureTimes, type CaptureEstimate } from './estimateCaptureTime';
import type { MediaKind } from './scanFiles';
import type { FileEntry } from '../store';

/** One blob to stream: the full object key (= media_path) plus its source. */
export type UploadItem = {
  id: string; // FileEntry id (= relPath within the chosen folder)
  localPath: string; // source path within the chosen folder; resume reconciles on it
  fileName: string;
  objectName: string; // resolved bundle-relative object name (the key's tail)
  key: string; // full S3 object key, identical to media_path
  file: File;
  size: number;
  sha256: string;
  timestampSource?: TimestampSource;
  captureTimestamp?: string; // resolved ISO 8601 UTC capture time (post-tz), media.csv col 4
  mediaKind: MediaKind;
  mimeType: string;
  preTags?: FlipObservation[]; // species applied in the tagger before this upload
};

export type BundlePreview = {
  uploadPath: string;
  bucket: string;
  deploymentId: string;
  fileCount: number;
  totalBytes: number;
  metadataBundleSha256: string;
  deploymentsCsv: string;
  mediaCsv: string;
  observationsCsv: string;
  uploadMetaJson: string;
  uploadCompleteJson: string;
  /** Per-file upload plan; the orchestrator (P4) streams these to `key`. */
  items: UploadItem[];
};

const enc = new TextEncoder();

/** Whether a file counts toward `imagesWithSpecies` — camtrap's definition
 *  (any positive-count identification, Ghost included), so this number agrees
 *  with what the tagger's sync delta would later compute. */
const hasSpecies = (preTags: FlipObservation[] | undefined): boolean =>
  hasSpeciesPresent(preTags ?? []);

/**
 * The observation rows for one file, shared by both bundle builders so a
 * tagged file publishes byte-identically whichever path produced the bundle.
 *
 * A file the tagger never touched falls through to `untagged`, which is each
 * path's own existing behaviour — no row at all from `buildBundle`, one
 * placeholder row from `buildBundleFromRecords`.
 */
function observationRowsFor(
  file: {
    mediaId: string;
    objectName: string;
    deploymentId: string;
    timestamp: string;
    preTags?: FlipObservation[];
  },
  untagged: () => Observation[],
): Observation[] {
  const preTags = file.preTags ?? [];
  if (preTags.length === 0) return untagged();
  return preTags.map((o, i) => ({
    observationId: defaultObservationId(file.objectName, i),
    mediaId: file.mediaId,
    deploymentId: file.deploymentId,
    timestamp: file.timestamp,
    observationType: 'animal' as const,
    scientificName: o.scientificName,
    count: o.count,
    // Free tags are raw `[PREFIX:value]` markers the tagger preserved verbatim;
    // parsing them back into markers keeps them in the col-19 string alongside
    // the two reserved ones instead of appended as loose text.
    tags: buildObservationComments({
      commonName: o.commonName || undefined,
      requestedSpecies: o.requestedSpecies || undefined,
      extra: parseTagMarkers(o.freeTags),
    }),
  }));
}

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Frozen naming decisions for a batch: the deployment stamp/upload path, and
 * every scanned file's pre-suffix sanitized name plus collision counts. Names
 * depend only on relPath/fileName (known at Drop), never on file content, so
 * this can — and for a streamed run, must — be computed once, before any file
 * has finished processing, and reused verbatim thereafter: no file's key ever
 * has to change once it's been decided. */
export type BatchNaming = {
  uploadPath: string;
  nameFor: Map<string, string>; // FileEntry.id -> sanitized (pre-suffix) name
  counts: Map<string, number>; // sanitized-name occurrence counts, whole batch
};

export function resolveBatchNaming(input: {
  collectionUuid: string;
  uploaderSlug: string;
  now: Date;
  files: { id: string; relPath: string; fileName: string }[];
}): BatchNaming {
  const stamp = uploadStamp(input.now);
  const uploadPath = `Collections/${input.collectionUuid}/Uploads/${stamp}_${input.uploaderSlug}`;
  return namingForUploadPath(uploadPath, input.files);
}

/** The same sanitize/collision-count pass `resolveBatchNaming` does, against
 * an already-known `uploadPath` instead of stamping a fresh one — for resume,
 * where the prefix is fixed (persisted at the original run's start) and must
 * be reused verbatim, not regenerated. Pure function of relPath/fileName, so
 * recomputing it from the full persisted file list is always identical to
 * what the original run computed, regardless of processing order. */
export function namingForUploadPath(
  uploadPath: string,
  files: { id: string; relPath: string; fileName: string }[],
): BatchNaming {
  const nameFor = new Map<string, string>();
  for (const f of files) {
    const safe = sanitizeRelPath(f.relPath);
    nameFor.set(f.id, safe.ok ? safe.name : f.fileName);
  }
  const counts = nameCounts([...nameFor.values()].map((name) => ({ name })));
  return { uploadPath, nameFor, counts };
}

/** Resolve one file's final object name/key once it has a hash, against a
 * frozen `BatchNaming`. Stable from the moment it's returned — safe to upload
 * a blob under this key immediately, it will never need to change. */
export function objectKeyFor(
  id: string,
  sha256: string,
  naming: BatchNaming,
): { objectName: string; key: string } {
  const name = naming.nameFor.get(id)!;
  const objectName = resolveOneName(name, sha256, naming.counts);
  return { objectName, key: `${naming.uploadPath}/${objectName}` };
}

const mimeFor = (f: FileEntry): string =>
  f.mimeType ?? (f.mediaKind === 'video' ? 'video/mp4' : 'image/jpeg');

/**
 * Resolve one ready file's full upload item — key, capture time, mime type —
 * against a frozen `BatchNaming`. Used both by `buildBundle`'s final pass
 * (over the complete ready set) and by a streamed run enqueueing one file the
 * moment it individually finishes Inspect.
 */
export function planItemFor(f: FileEntry, naming: BatchNaming, timeZone: string, estimates: Map<string, CaptureEstimate>): UploadItem {
  const estimate = estimates.get(f.id);
  const naive = f.exifNaive ?? f.manualNaive ?? estimate!.naive;
  const { objectName, key } = objectKeyFor(f.id, f.sha256!, naming);
  return {
    id: f.id,
    localPath: f.relPath,
    fileName: f.fileName,
    objectName,
    key,
    file: f.file,
    size: f.size,
    sha256: f.sha256!,
    captureTimestamp: naiveInZoneToUtcIso(naive, timeZone),
    timestampSource: f.exifNaive ? undefined : f.manualNaive ? f.manualSource ?? 'manual' : estimate!.method,
    mediaKind: f.mediaKind,
    mimeType: mimeFor(f),
    preTags: f.preTags,
  };
}

export type BuildInput = {
  location: Location;
  collectionUuid: string;
  bucket: string;
  uploaderSlug: string;
  description: string;
  timeZone: string; // IANA zone the EXIF naive wall-clock is interpreted in
  files: FileEntry[];
  now: Date;
  /** Reuse an already-frozen naming resolution (a streamed run) instead of
   * resolving fresh from the currently-ready subset (the Assign preview). */
  naming?: BatchNaming;
};

/**
 * Build the five bundle payloads from the chosen deployment, identity, and the
 * processed files. Only files that finished processing with a hash are
 * included; collisions in the bundle-relative name get a deterministic suffix.
 */
export async function buildBundle(input: BuildInput): Promise<BundlePreview> {
  const { location, collectionUuid, bucket, uploaderSlug, description, timeZone, files, now } = input;

  const ready = files.filter((f) => f.processState === 'ready' && f.sha256);

  const naming =
    input.naming ??
    resolveBatchNaming({
      collectionUuid,
      uploaderSlug,
      now,
      files: ready,
    });
  const uploadPath = naming.uploadPath;

  const deployment = locationToDeployment(location, collectionUuid);

  // Resolve each file's key/capture-time/mime-type once (per-file work isn't
  // free), then project into media rows, observation rows, and upload items.
  const estimates = estimateCaptureTimes(files, timeZone);
  const uploadItems: UploadItem[] = ready.map((f) => planItemFor(f, naming, timeZone, estimates));
  deployment.timestampIssues = uploadItems.some((it) => !!it.timestampSource);

  const media: Media[] = uploadItems.map((it) => ({
    mediaId: it.key,
    deploymentId: deployment.deploymentId,
    mediaPath: it.key,
    fileName: it.fileName,
    timestamp: it.captureTimestamp ?? '',
    mimeType: it.mimeType,
    comments: buildMediaComments({ timestampSource: it.timestampSource }),
  }));

  // A batch that came back from the tagger already carrying species publishes
  // those rows here instead of a placeholder. An untagged file gets one blank
  // placeholder so every image is present in observations.csv from the start.
  const observations: Observation[] = uploadItems.flatMap((it) =>
    observationRowsFor(
      {
        mediaId: it.key,
        objectName: it.objectName,
        deploymentId: deployment.deploymentId,
        timestamp: it.captureTimestamp ?? '',
        preTags: it.preTags,
      },
      () => [
        {
          observationId: defaultObservationId(it.objectName, 0),
          mediaId: it.key,
          deploymentId: deployment.deploymentId,
          timestamp: it.captureTimestamp ?? '',
          observationType: 'blank',
          scientificName: '',
          tags: '',
        },
      ],
    ),
  );

  const deploymentsCsv = serializeDeployments([deployment]);
  const mediaCsv = serializeMedia(media);
  const observationsCsv = serializeObservations(observations);

  const uploadMetaJson = serializeUploadMeta(
    buildUploadMeta({
      uploadUser: uploaderSlug,
      date: now,
      imageCount: ready.length,
      imagesWithSpecies: uploadItems.filter((it) => hasSpecies(it.preTags)).length,
      bucket,
      uploadPath,
      description,
    }),
  );

  // metadataBundleSha256 commits the bundle's index: the exact bytes of
  // UploadMeta.json followed by the three CSVs, in that order.
  const metadataBundleSha256 = await sha256Hex([
    enc.encode(uploadMetaJson),
    enc.encode(deploymentsCsv),
    enc.encode(mediaCsv),
    enc.encode(observationsCsv),
  ]);

  const complete: UploadCompleteJson = {
    schemaVersion: 1,
    uploadPath,
    fileCount: ready.length,
    metadataBundleSha256,
    files: media.map((m, i) => ({
      media_path: m.mediaPath,
      size: ready[i].size,
      sha256: ready[i].sha256!,
    })),
    completedAt: now.toISOString(),
  };

  return {
    uploadPath,
    bucket,
    deploymentId: deployment.deploymentId,
    fileCount: ready.length,
    totalBytes: ready.reduce((n, f) => n + f.size, 0),
    metadataBundleSha256,
    deploymentsCsv,
    mediaCsv,
    observationsCsv,
    uploadMetaJson,
    uploadCompleteJson: serializeUploadComplete(complete),
    items: uploadItems,
  };
}

/** A fully-resolved persisted file record — every field `buildBundleFromRecords`
 * needs. Deliberately narrower than `FileRecord` (not importing `./db` here
 * to avoid coupling this module to the resume store's schema); the caller
 * (resume.ts) is responsible for only passing records that have every field. */
export type ResolvedFileRecord = {
  fileName: string;
  size: number;
  sha256: string;
  remoteKey: string;
  timestampSource?: TimestampSource;
  captureTimestamp?: string;
  mimeType?: string;
  preTags?: FlipObservation[];
};

export type ResumeBundle = {
  metadataBundleSha256: string;
  deploymentsCsv: string;
  mediaCsv: string;
  observationsCsv: string;
  uploadMetaJson: string;
  uploadCompleteJson: string;
};

/**
 * Build the same five bundle payloads as `buildBundle`, but from already-
 * resolved persisted records instead of live `FileEntry`s — for resuming a
 * session that was interrupted before it ever reached publish (no bundle was
 * ever built). The upload path is the one already persisted at the original
 * run's start (`BatchRecord.uploadPrefix`), reused verbatim rather than
 * re-stamped, so this publishes to the same destination the original run was
 * headed for instead of a new one.
 */
export async function buildBundleFromRecords(input: {
  location: Location;
  collectionUuid: string;
  bucket: string;
  uploaderSlug: string;
  description: string;
  uploadPath: string;
  startedAt: Date;
  files: ResolvedFileRecord[];
}): Promise<ResumeBundle> {
  const { location, collectionUuid, bucket, uploaderSlug, description, uploadPath, startedAt, files } = input;
  const deployment = locationToDeployment(location, collectionUuid);

  deployment.timestampIssues = files.some((f) => !!f.timestampSource);
  const media: Media[] = files.map((f) => ({
    mediaId: f.remoteKey,
    deploymentId: deployment.deploymentId,
    mediaPath: f.remoteKey,
    fileName: f.fileName,
    timestamp: f.captureTimestamp ?? '',
    mimeType: f.mimeType ?? 'application/octet-stream',
    comments: buildMediaComments({ timestampSource: f.timestampSource }),
  }));

  // A resumed-before-bundle batch's observations.csv must publish the same
  // shape as a normal upload's. A file the tagger identified publishes its
  // species rows instead of a placeholder.
  const observations: Observation[] = files.flatMap((f) => {
    const objectName = f.remoteKey.slice(uploadPath.length + 1);
    return observationRowsFor(
      {
        mediaId: f.remoteKey,
        objectName,
        deploymentId: deployment.deploymentId,
        timestamp: f.captureTimestamp ?? '',
        preTags: f.preTags,
      },
      () => [
        {
          observationId: defaultObservationId(objectName, 0),
          mediaId: f.remoteKey,
          deploymentId: deployment.deploymentId,
          timestamp: f.captureTimestamp ?? '',
          observationType: 'blank',
          scientificName: '',
          tags: '',
        },
      ],
    );
  });

  const deploymentsCsv = serializeDeployments([deployment]);
  const mediaCsv = serializeMedia(media);
  const observationsCsv = serializeObservations(observations);

  const uploadMetaJson = serializeUploadMeta(
    buildUploadMeta({
      uploadUser: uploaderSlug,
      date: startedAt,
      imageCount: files.length,
      imagesWithSpecies: files.filter((f) => hasSpecies(f.preTags)).length,
      bucket,
      uploadPath,
      description,
    }),
  );

  const metadataBundleSha256 = await sha256Hex([
    enc.encode(uploadMetaJson),
    enc.encode(deploymentsCsv),
    enc.encode(mediaCsv),
    enc.encode(observationsCsv),
  ]);

  const complete: UploadCompleteJson = {
    schemaVersion: 1,
    uploadPath,
    fileCount: files.length,
    metadataBundleSha256,
    files: media.map((m, i) => ({
      media_path: m.mediaPath,
      size: files[i].size,
      sha256: files[i].sha256,
    })),
    completedAt: startedAt.toISOString(),
  };

  return {
    metadataBundleSha256,
    deploymentsCsv,
    mediaCsv,
    observationsCsv,
    uploadMetaJson,
    uploadCompleteJson: serializeUploadComplete(complete),
  };
}
