// The uploader contract: `buildBundle` must emit valid v016 Camtrap data that
// the shared `@sparcd/camtrap` readers parse, with one observations.csv row per
// file and species columns left blank — the same golden the tagger tests rely
// on. This test reuses the shared fixtures and readers from
// `packages/camtrap/test`, so the uploader and tagger prove the same data
// contract against the same bytes.

import { describe, it, expect } from 'vitest';
import {
  parseDeployments,
  parseMedia,
  parseObservations,
  parseUploadMeta,
  parseCsvRows,
  serializeCsvRows,
  validateColumnCount,
  commonNameFromComments,
  requestedSpeciesFromComments,
  parseTagMarkers,
  DEPLOY_COLUMN_COUNT,
  MEDIA_COLUMN_COUNT,
  OBS_COLUMN_COUNT,
  MEDIA_COL,
} from '@sparcd/camtrap';
import {
  buildBundle,
  resolveBatchNaming,
  namingForUploadPath,
  objectKeyFor,
  buildBundleFromRecords,
  type BuildInput,
  type ResolvedFileRecord,
} from '../src/lib/bundle';
import type { Location } from '../src/lib/locations';
import type { FileEntry } from '../src/store';
import type { FlipObservation } from '@sparcd/flip';

const UUID = '8dbd9c43-5c3d-411d-8778-617d4693c69b';

const SAN15: Location = {
  key: `SAN15|31.5,-110.2`,
  id: 'SAN15',
  name: 'San Pedro 15',
  latitude: 31.5,
  longitude: -110.2,
  elevation: 1200,
};

import type { NaiveDateTime } from '../src/lib/exifTime';

// A naive wall-clock with no zone (the camera's local time, as EXIF stores it).
const naive = (over: Partial<NaiveDateTime> = {}): NaiveDateTime => ({
  year: 2024,
  month: 1,
  day: 10,
  hour: 8,
  minute: 0,
  second: 0,
  ...over,
});

// A ready FileEntry backed by a real File so `crypto.subtle` has bytes to hash.
function ready(
  relPath: string,
  opts: {
    exifNaive?: NaiveDateTime;
    manualNaive?: NaiveDateTime;
    mediaKind?: FileEntry['mediaKind'];
  } = {},
): FileEntry {
  const mediaKind = opts.mediaKind ?? 'image';
  const mimeType = mediaKind === 'video' ? 'video/mp4' : 'image/jpeg';
  const bytes = new TextEncoder().encode(`fake:${relPath}`);
  const file = new File([bytes], relPath.split('/').pop()!, { type: mimeType });
  return {
    id: relPath,
    file,
    relPath,
    fileName: file.name,
    size: bytes.length,
    mediaKind,
    mimeType,
    processState: 'ready',
    sha256: `sha-${relPath}`,
    exifNaive: 'exifNaive' in opts ? opts.exifNaive : naive(),
    manualNaive: opts.manualNaive,
  };
}

function build(
  files: FileEntry[],
  timeZone = 'America/Phoenix',
): ReturnType<typeof buildBundle> {
  const input: BuildInput = {
    location: SAN15,
    collectionUuid: UUID,
    bucket: `sparcd-${UUID}`,
    uploaderSlug: 'jdoe',
    description: 'Educational Test — uploader bundle',
    timeZone,
    files,
    now: new Date(2024, 0, 15, 10, 0, 0),
  };
  return buildBundle(input);
}

describe('uploader bundle is valid v016 Camtrap data', () => {
  it('writes one observations.csv row per file, species columns blank', async () => {
    const b = await build([ready('a/IMG001.JPG', { exifNaive: naive({ hour: 8 }) })]);
    const rows = parseObservations(b.observationsCsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].observationId).toBe('a/IMG001.JPG:0');
    expect(rows[0].scientificName).toBe('');
    expect(rows[0].tags).toBe('');
    expect(rows[0].count).toBe(0); // blank column reads back as 0
    // Observation timestamp matches the media row's EXIF-derived capture time.
    expect(rows[0].timestamp).toBe(parseMedia(b.mediaCsv)[0].timestamp);
  });

  it('media.csv carries the DST-corrected full ISO capture time in col 4', async () => {
    // The uploader is the writer-of-record for capture time: the naive EXIF
    // wall-clock 08:00 interpreted in America/Phoenix (UTC-7, no DST) is 15:00Z,
    // written as a full ISO 8601 UTC string — matching how sparcd-web itself
    // stamps timestamps.
    const b = await build([ready('a/IMG001.JPG', { exifNaive: naive({ hour: 8 }) })], 'America/Phoenix');
    const rows = parseMedia(b.mediaCsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe('2024-01-10T15:00:00.000Z');
  });

  it('capture time is independent of the chosen zone going in (proves tz applied)', async () => {
    // Same naive wall-clock, two different zones → two different UTC instants.
    const phx = await build([ready('a/IMG001.JPG', { exifNaive: naive({ hour: 8 }) })], 'America/Phoenix');
    const utc = await build([ready('a/IMG001.JPG', { exifNaive: naive({ hour: 8 }) })], 'UTC');
    expect(parseMedia(phx.mediaCsv)[0].timestamp).toBe('2024-01-10T15:00:00.000Z');
    expect(parseMedia(utc.mediaCsv)[0].timestamp).toBe('2024-01-10T08:00:00.000Z');
  });

  it('a video media row carries the video media type', async () => {
    const b = await build([ready('a/CLIP.MP4', { mediaKind: 'video', exifNaive: naive() })]);
    const rows = parseMedia(b.mediaCsv);
    expect(rows[0].mimeType).toBe('video/mp4');
  });

  it('a file with no camera time receives an estimated capture time', async () => {
    const b = await build([ready('a/CLIP.MP4', { mediaKind: 'video', exifNaive: undefined })]);
    expect(parseMedia(b.mediaCsv)[0].timestamp).toBe(b.items[0].captureTimestamp);
    expect(parseMedia(b.mediaCsv)[0].comments).toBe('[TIMESTAMP:file-modified]');
  });

  it('a manual capture time fills col 4 (DST-corrected) when EXIF is absent', async () => {
    const b = await build(
      [ready('a/IMG001.JPG', { exifNaive: undefined, manualNaive: naive({ hour: 8 }) })],
      'America/Phoenix',
    );
    expect(parseMedia(b.mediaCsv)[0].timestamp).toBe('2024-01-10T15:00:00.000Z');
  });

  it('prefers EXIF over a stray manual time so a real camera time is never clobbered', async () => {
    const b = await build(
      [ready('a/IMG001.JPG', { exifNaive: naive({ hour: 8 }), manualNaive: naive({ hour: 20 }) })],
      'America/Phoenix',
    );
    expect(parseMedia(b.mediaCsv)[0].timestamp).toBe('2024-01-10T15:00:00.000Z');
  });

  it('media rows carry the full object key as media_id and round-trip', async () => {
    const b = await build([ready('a/IMG001.JPG'), ready('b/IMG002.JPG')]);
    const media = parseMedia(b.mediaCsv);
    expect(media).toHaveLength(2);
    for (const m of media) {
      expect(m.mediaId).toBe(m.mediaPath);
      expect(m.mediaPath.startsWith(`${b.uploadPath}/`)).toBe(true);
      expect(m.mimeType).toBe('image/jpeg');
    }
    expect(serializeCsvRows(parseCsvRows(b.mediaCsv))).toBe(b.mediaCsv);
    expect(validateColumnCount(parseCsvRows(b.mediaCsv), MEDIA_COLUMN_COUNT)).toBeNull();
  });

  it('deployments.csv reads back the chosen location and round-trips', async () => {
    const b = await build([ready('a/IMG001.JPG')]);
    const [d] = parseDeployments(b.deploymentsCsv);
    expect(d.locationId).toBe('SAN15');
    expect(d.locationName).toBe('San Pedro 15');
    expect(d.longitude).toBeCloseTo(-110.2, 5);
    expect(d.latitude).toBeCloseTo(31.5, 5);
    expect(d.elevation).toBeCloseTo(1200, 5);
    expect(d.deploymentId).toBe(`${UUID}:SAN15`);
    expect(serializeCsvRows(parseCsvRows(b.deploymentsCsv))).toBe(b.deploymentsCsv);
    expect(validateColumnCount(parseCsvRows(b.deploymentsCsv), DEPLOY_COLUMN_COUNT)).toBeNull();
  });

  it('UploadMeta.json starts at zero species and no edits', async () => {
    const b = await build([ready('a/IMG001.JPG'), ready('b/IMG002.JPG')]);
    const meta = parseUploadMeta(b.uploadMetaJson);
    expect(meta.imagesWithSpecies).toBe(0);
    expect(meta.imageCount).toBe(2);
    expect(meta.editComments).toEqual([]);
    expect(meta.bucket).toBe(`sparcd-${UUID}`);
  });
});

describe('bundle only includes processed files', () => {
  it('excludes queued/errored files and those without a hash', async () => {
    const files: FileEntry[] = [
      ready('a/IMG001.JPG'),
      { ...ready('b/IMG002.JPG'), processState: 'queued', sha256: undefined },
      { ...ready('c/IMG003.JPG'), processState: 'error', processError: 'boom' },
    ];
    const b = await build(files);
    expect(b.fileCount).toBe(1);
    expect(b.items).toHaveLength(1);
    expect(parseMedia(b.mediaCsv)).toHaveLength(1);
    expect(parseMedia(b.mediaCsv)[0].fileName).toBe('IMG001.JPG');
  });
});

describe('bundle integrity hash', () => {
  it('is a stable 64-hex digest for identical input', async () => {
    const a = await build([ready('a/IMG001.JPG'), ready('b/IMG002.JPG')]);
    const c = await build([ready('a/IMG001.JPG'), ready('b/IMG002.JPG')]);
    expect(a.metadataBundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.metadataBundleSha256).toBe(c.metadataBundleSha256);
  });

  it('every media row is reachable by its full key (reader listing parity)', async () => {
    const b = await build([ready('nested/deep/IMG009.JPG')]);
    const rows = parseCsvRows(b.mediaCsv);
    const keys = new Set(b.items.map((i) => i.key));
    for (const r of rows) expect(keys.has(r[MEDIA_COL.mediaId])).toBe(true);
  });
});

// Resume-before-bundle (a session interrupted before it ever reached publish)
// reconstructs naming from persisted records instead of live FileEntrys, and
// reuses the already-persisted upload path instead of stamping a fresh one.
// Both properties below are load-bearing: get either wrong and a resumed
// upload's keys diverge from what a from-scratch run of the same batch would
// have produced.
describe('resume: naming reconstructed from persisted records', () => {
  it('produces the same key as the original run, including a name collision', () => {
    const files = [
      { id: 'a/IMG.JPG', relPath: 'a/IMG.JPG', fileName: 'IMG.JPG' },
      { id: 'b/IMG.JPG', relPath: 'b/IMG.JPG', fileName: 'IMG.JPG' }, // same sanitized name — collides
    ];
    const original = resolveBatchNaming({
      collectionUuid: UUID,
      uploaderSlug: 'jdoe',
      now: new Date(2024, 0, 15, 10, 0, 0),
      files,
    });
    // The "resume" side only ever sees the fixed, already-persisted upload
    // path — never a fresh `now`.
    const reconstructed = namingForUploadPath(original.uploadPath, files);

    for (const f of files) {
      const seed = `sha-${f.id}`;
      const originalKey = objectKeyFor(f.id, seed, original);
      const reconstructedKey = objectKeyFor(f.id, seed, reconstructed);
      expect(reconstructedKey).toEqual(originalKey);
    }
  });
});

describe('resume: buildBundleFromRecords', () => {
  const UPLOAD_PATH = `Collections/${UUID}/Uploads/2024.01.15.10.00.00_jdoe`;
  const record = (over: Partial<ResolvedFileRecord> = {}): ResolvedFileRecord => ({
    fileName: 'IMG001.JPG',
    size: 12,
    sha256: 'sha-a',
    remoteKey: `${UPLOAD_PATH}/IMG001.JPG`,
    captureTimestamp: '2024-01-10T08:00:00',
    mimeType: 'image/jpeg',
    ...over,
  });

  it('emits a valid bundle from persisted records alone, one observation row per file', async () => {
    const b = await buildBundleFromRecords({
      location: SAN15,
      collectionUuid: UUID,
      bucket: `sparcd-${UUID}`,
      uploaderSlug: 'jdoe',
      description: 'Educational Test — resumed upload',
      uploadPath: UPLOAD_PATH,
      startedAt: new Date(2024, 0, 15, 10, 0, 0),
      files: [record()],
    });
    const observations = parseObservations(b.observationsCsv);
    expect(observations).toHaveLength(1);
    expect(observations[0].observationId).toBe('IMG001.JPG:0');
    expect(observations[0].mediaId).toBe(record().remoteKey);
    expect(observations[0].scientificName).toBe('');
    const media = parseMedia(b.mediaCsv);
    expect(media).toHaveLength(1);
    expect(media[0].fileName).toBe('IMG001.JPG');
    expect(media[0].mediaId).toBe(record().remoteKey);
    expect(b.metadataBundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateColumnCount(parseCsvRows(b.deploymentsCsv), DEPLOY_COLUMN_COUNT)).toBeNull();
    expect(validateColumnCount(parseCsvRows(b.mediaCsv), MEDIA_COLUMN_COUNT)).toBeNull();
    expect(validateColumnCount(parseCsvRows(b.observationsCsv), OBS_COLUMN_COUNT)).toBeNull();
  });
});

// A batch that went through the tagger before it was ever uploaded (the "flip").
// The images and their identifications have to publish together, and both bundle
// builders have to produce the same rows for the same tagged file — one is used
// by a normal run, the other by a run resumed before it reached publish.
describe('a batch tagged before upload publishes its species', () => {
  const coyote: FlipObservation = {
    scientificName: 'Canis latrans',
    commonName: 'Coyote',
    count: 2,
    requestedSpecies: '',
    freeTags: '',
  };
  const ghost: FlipObservation = {
    scientificName: 'Casper',
    commonName: 'Ghost',
    count: 1,
    requestedSpecies: '',
    freeTags: '',
  };

  it('emits one observation row per applied species, with the tag markers', async () => {
    const b = await build([{ ...ready('a/IMG001.JPG'), preTags: [coyote] }]);
    const rows = parseObservations(b.observationsCsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].scientificName).toBe('Canis latrans');
    expect(rows[0].count).toBe(2);
    expect(rows[0].mediaId).toBe(b.items[0].key);
    expect(rows[0].observationId).toBe('a/IMG001.JPG:0');
    expect(rows[0].timestamp).toBe(b.items[0].captureTimestamp);
    expect(commonNameFromComments(rows[0].tags)).toBe('Coyote');
    expect(validateColumnCount(parseCsvRows(b.observationsCsv), OBS_COLUMN_COUNT)).toBeNull();
  });

  it('gives a multi-species image one row each, numbered in apply order', async () => {
    const puma: FlipObservation = { ...coyote, scientificName: 'Puma concolor', commonName: 'Mountain Lion', count: 1 };
    const b = await build([{ ...ready('a/IMG001.JPG'), preTags: [coyote, puma] }]);
    const rows = parseObservations(b.observationsCsv);
    expect(rows.map((r) => r.scientificName)).toEqual(['Canis latrans', 'Puma concolor']);
    expect(rows.map((r) => r.observationId)).toEqual([
      'a/IMG001.JPG:0',
      'a/IMG001.JPG:1',
    ]);
  });

  it('carries a requested species and free-form markers through untouched', async () => {
    const requested: FlipObservation = {
      scientificName: 'Canis latrans',
      commonName: 'Coyote',
      count: 1,
      requestedSpecies: 'Ringtail',
      freeTags: '[NOTE:blurry]',
    };
    const b = await build([{ ...ready('a/IMG001.JPG'), preTags: [requested] }]);
    const [row] = parseObservations(b.observationsCsv);
    expect(requestedSpeciesFromComments(row.tags)).toBe('Ringtail');
    expect(parseTagMarkers(row.tags)).toContainEqual({ prefix: 'NOTE', value: 'blurry' });
  });

  it('writes a blank placeholder row for each untagged file', async () => {
    const b = await build([
      { ...ready('a/IMG001.JPG'), preTags: [coyote] },
      { ...ready('b/IMG002.JPG'), preTags: [] },
      ready('c/IMG003.JPG'),
    ]);
    const rows = parseObservations(b.observationsCsv);
    expect(rows).toHaveLength(3);
    expect(rows[0].mediaId).toBe(b.items[0].key);
    expect(rows[0].observationType).toBe('animal');
    expect(rows[1].mediaId).toBe(b.items[1].key);
    expect(rows[1].observationType).toBe('blank');
    expect(rows[2].mediaId).toBe(b.items[2].key);
    expect(rows[2].observationType).toBe('blank');
  });

  it('counts every identified image in imagesWithSpecies — Ghost included, per camtrap', async () => {
    const b = await build([
      { ...ready('a/IMG001.JPG'), preTags: [coyote] },
      { ...ready('b/IMG002.JPG'), preTags: [ghost] },
      ready('c/IMG003.JPG'),
    ]);
    const meta = parseUploadMeta(b.uploadMetaJson);
    expect(meta.imageCount).toBe(3);
    expect(meta.imagesWithSpecies).toBe(2);
  });

  it('still marks an empty frame as tagged in observations.csv', async () => {
    const b = await build([{ ...ready('a/IMG001.JPG'), preTags: [ghost] }]);
    const [row] = parseObservations(b.observationsCsv);
    expect(row.scientificName).toBe('Casper');
    expect(commonNameFromComments(row.tags)).toBe('Ghost');
  });

  it('publishes the same filename-indexed rows whether the bundle was built live or from records', async () => {
    const puma: FlipObservation = { ...coyote, scientificName: 'Puma concolor', commonName: 'Mountain Lion', count: 1 };
    const live = await build([{ ...ready('a/IMG001.JPG'), preTags: [coyote, puma] }]);
    const item = live.items[0];
    const resumed = await buildBundleFromRecords({
      location: SAN15,
      collectionUuid: UUID,
      bucket: `sparcd-${UUID}`,
      uploaderSlug: 'jdoe',
      description: 'Educational Test — uploader bundle',
      uploadPath: live.uploadPath,
      startedAt: new Date(2024, 0, 15, 10, 0, 0),
      files: [
        {
          fileName: item.fileName,
          size: item.size,
          sha256: item.sha256,
          remoteKey: item.key,
          captureTimestamp: item.captureTimestamp,
          mimeType: item.mimeType,
          preTags: [coyote, puma],
        },
      ],
    });
    expect(resumed.observationsCsv).toBe(live.observationsCsv);
    expect(parseObservations(resumed.observationsCsv).map((row) => row.observationId)).toEqual([
      'a/IMG001.JPG:0',
      'a/IMG001.JPG:1',
    ]);
    expect(parseUploadMeta(resumed.uploadMetaJson).imagesWithSpecies).toBe(1);
  });

  it('keeps the placeholder row for an untagged file on the resume path', async () => {
    const resumePath = `Collections/${UUID}/Uploads/2024.01.15.10.00.00_jdoe`;
    const b = await buildBundleFromRecords({
      location: SAN15,
      collectionUuid: UUID,
      bucket: `sparcd-${UUID}`,
      uploaderSlug: 'jdoe',
      description: 'Educational Test — resumed upload',
      uploadPath: resumePath,
      startedAt: new Date(2024, 0, 15, 10, 0, 0),
      files: [
        {
          fileName: 'IMG001.JPG',
          size: 12,
          sha256: 'sha-a',
          remoteKey: `${resumePath}/IMG001.JPG`,
          captureTimestamp: '2024-01-10T08:00:00',
          mimeType: 'image/jpeg',
        },
      ],
    });
    const rows = parseObservations(b.observationsCsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].observationId).toBe('IMG001.JPG:0');
    expect(rows[0].scientificName).toBe('');
  });
});

describe('timestamp issues', () => {
  it('flags estimated, manual and spread times while camera rows stay blank', async () => {
    const b = await build([
      ready('1'), ready('2', { exifNaive: undefined }), ready('3'),
      ready('4', { exifNaive: undefined, manualNaive: naive() }),
      { ...ready('5', { exifNaive: undefined, manualNaive: naive() }), manualSource: 'spread' },
    ]);
    expect(parseCsvRows(b.deploymentsCsv)[0][15]).toBe('true');
    expect(parseCsvRows(b.mediaCsv).map((r) => r[10])).toEqual([
      '', '[TIMESTAMP:interpolated]', '', '[TIMESTAMP:manual]', '[TIMESTAMP:spread]',
    ]);
    expect(b.items.every((i) => !!i.captureTimestamp)).toBe(true);
    const resumed = await buildBundleFromRecords({
      location: SAN15, collectionUuid: UUID, bucket: `sparcd-${UUID}`, uploaderSlug: 'jdoe',
      description: '', uploadPath: b.uploadPath, startedAt: new Date(),
      files: b.items.map((i) => ({ ...i, remoteKey: i.key })),
    });
    expect(resumed.mediaCsv).toBe(b.mediaCsv);
    expect(resumed.deploymentsCsv).toBe(b.deploymentsCsv);
  });
  it('does not flag camera timestamps', async () => {
    const b = await build([ready('1')]);
    expect(parseCsvRows(b.deploymentsCsv)[0][15]).toBe('false');
    expect(parseCsvRows(b.mediaCsv)[0][10]).toBe('');
  });
});
