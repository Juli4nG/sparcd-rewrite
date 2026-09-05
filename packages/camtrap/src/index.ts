// Camtrap-DP-flavored types shared by the SPARC'd tools. Pure TS — no React,
// no S3. The uploader becomes the writer-of-record here; the tagger reads.
//
// The writer below produces the exact byte shape SPARC'd already writes,
// verified against the live Educational Test collection and the upstream
// `camtrap/v016` module: three no-header CSVs whose readers parse by fixed
// column *position*, plus the `UploadMeta.json` shape. SPARC'd's writer
// quotes every field (QUOTE_ALL), terminates each row with a bare LF, and
// leaves a trailing newline — matched here so a round-trip is byte-stable.

/** One row of `deployments.csv` — a camera location for one upload. */
export type TimestampSource = 'manual' | 'spread' | 'interpolated' | 'offset' | 'file-modified';

export type Deployment = {
  timestampIssues?: boolean;
  deploymentId: string; // "<collection-uuid>:<location-id>"
  locationId: string;
  locationName: string;
  latitude: number;
  longitude: number;
  elevation: number; // metres; serialized into the v016 `camera_height` column
};

/** One row of `media.csv` — one image blob. */
export type Media = {
  comments?: string;
  mediaId: string;
  deploymentId: string;
  mediaPath: string; // full S3 object key under the upload prefix
  fileName: string; // local filename
  timestamp: string; // ISO, from EXIF
  mimeType: string; // "image/jpeg"
};

/**
 * One row of `observations.csv` — species + count. The uploader writes one row
 * per media file at upload time with the species fields blank (`scientificName:
 * ''`, `count: undefined`) since nothing has been identified yet; the tagger
 * later fills them in via `mergeObservations`.
 */
export type Observation = {
  observationId: string;
  mediaId: string;
  deploymentId: string;
  timestamp: string; // ISO; v016 observation timestamp column
  observationType: 'animal' | 'blank'; // "blank" = no species identified yet
  scientificName: string;
  count?: number; // undefined → column written blank (no species identified)
  tags: string; // concatenated [PREFIX:value] markers
};

/** All three collections for one upload bundle. */
export type CamtrapBundle = {
  deployments: Deployment[];
  media: Media[];
  observations: Observation[];
};

// ---------------------------------------------------------------------------
// CSV writer — v016 fixed-position layout
//
// Verified live (Educational Test bucket) and against upstream `camtrap/v016`:
//   deployments.csv  23 columns
//   media.csv        11 columns
//   observations.csv 20 columns (one row per file on initial upload, species
//                     columns blank until the tagger identifies something)
// Every field is quoted; rows are LF-terminated including a trailing newline.
// Readers index by position, so column count and order are the contract.
// ---------------------------------------------------------------------------

function csvRow(fields: string[]): string {
  return fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(',') + '\n';
}

// SPARC'd writes coordinates / camera geometry with six decimals; integer-ish
// fields (uncertainty, interval, heading) stay bare. Matches the live bytes.
const f6 = (n: number): string => n.toFixed(6);

/** Serialize `deployments.csv` (one row per deployment), v016 23-column shape. */
export function serializeDeployments(deployments: Deployment[]): string {
  return deployments
    .map((d) =>
      csvRow([
        d.deploymentId, // 0  deployment_id
        d.locationId, // 1  location_id
        d.locationName, // 2  location_name
        f6(d.longitude), // 3  longitude  (note: before latitude)
        f6(d.latitude), // 4  latitude
        '0', // 5  coordinate_uncertainty
        '', // 6  start
        '', // 7  end
        '', // 8  setup_by
        '', // 9  camera_id
        '', // 10 camera_model
        '0', // 11 camera_interval
        f6(d.elevation), // 12 camera_height (elevation)
        '0.000000', // 13 camera_tilt
        '0', // 14 camera_heading
        d.timestampIssues ? 'true' : 'false', // 15 timestamp_issues
        '', // 16 bait_use
        '', // 17 session
        '', // 18 array
        '', // 19 feature_type
        '', // 20 habitat
        '', // 21 tags
        '', // 22 comments
      ]),
    )
    .join('');
}

/**
 * Serialize `media.csv` (one row per image), v016 11-column shape. The full S3
 * object key is repeated in the media_id / sequence_id / file_path positions,
 * matching SPARC'd's own writer.
 *
 * Col 4 carries `m.timestamp` verbatim — the uploader is the writer-of-record
 * for capture time and stamps a DST-corrected full ISO 8601 UTC timestamp
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`) here, matching how sparcd-web itself stamps
 * timestamps (`datetime.now(UTC).isoformat()` in `camtrap_utils.py`). It is
 * empty only when capture time is genuinely absent (e.g. a video without
 * container metadata, routed to manual entry). The tagger still merges later
 * per-image corrections via `mergeMedia`.
 */
export function serializeMedia(media: Media[]): string {
  return media
    .map((m) =>
      csvRow([
        m.mediaPath, // 0  media_id (= full key)
        m.deploymentId, // 1  deployment_id
        m.mediaPath, // 2  sequence_id (= full key)
        '', // 3  capture_method
        m.timestamp, // 4  timestamp (full ISO 8601 UTC, DST-corrected by the uploader)
        m.mediaPath, // 5  file_path (= full key)
        m.fileName, // 6  file_name
        m.mimeType, // 7  file_media_type
        '', // 8  exif_data
        'false', // 9  favorite
        m.comments ?? '', // 10 comments
      ]),
    )
    .join('');
}

/**
 * Serialize `observations.csv`, v016 20-column shape. `count` (and its
 * `count_new` companion) is written blank when `o.count` is `undefined` — the
 * shape an upload-time placeholder row carries before any species is
 * identified. An empty `observations` array still serializes to `''`.
 */
export function serializeObservations(observations: Observation[]): string {
  if (observations.length === 0) return '';
  return observations
    .map((o) =>
      csvRow([
        o.observationId, // 0  observation_id
        o.deploymentId, // 1  deployment_id
        '', // 2  sequence_id
        o.mediaId, // 3  media_id (= full key)
        o.timestamp, // 4  timestamp
        o.observationType, // 5  observation_type
        'false', // 6  camera_setup
        '', // 7  taxon_id
        o.scientificName, // 8  scientific_name
        o.count !== undefined ? String(o.count) : '', // 9  count
        o.count !== undefined ? '0' : '', // 10 count_new
        '', // 11 life_stage
        '', // 12 sex
        '', // 13 behaviour
        '', // 14 individual_id
        '', // 15 classification_method
        '', // 16 classified_by
        '', // 17 classification_timestamp
        '', // 18 classification_confidence
        o.tags, // 19 comments ([COMMONNAME:…])
      ]),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// UploadMeta.json — matched byte-for-byte to the live shape (2-space pretty,
// LF newlines, no trailing newline). `uploadDate` is a nested Java
// LocalDateTime-style object.
// ---------------------------------------------------------------------------

export type UploadDate = {
  date: { year: number; month: number; day: number };
  time: { hour: number; minute: number; second: number; nano: number };
};

export type UploadMetaJson = {
  uploadUser: string;
  uploadDate: UploadDate;
  imagesWithSpecies: number;
  imageCount: number;
  editComments: string[];
  bucket: string;
  uploadPath: string;
  description: string;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** The `<YYYY.MM.DD.HH.MM.SS>` stamp SPARC'd uses in upload prefix names. */
export function uploadStamp(d: Date): string {
  return (
    `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.` +
    `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  );
}

/** Local-time `uploadDate`, consistent with the prefix stamp from the same Date. */
export function uploadDateFrom(d: Date): UploadDate {
  return {
    date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
    time: {
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      nano: d.getMilliseconds() * 1_000_000,
    },
  };
}

export function buildUploadMeta(input: {
  uploadUser: string;
  date: Date;
  imageCount: number;
  imagesWithSpecies: number;
  bucket: string;
  uploadPath: string;
  description: string;
}): UploadMetaJson {
  // Key order matches the live file so the serialized bytes line up.
  return {
    uploadUser: input.uploadUser,
    uploadDate: uploadDateFrom(input.date),
    imagesWithSpecies: input.imagesWithSpecies,
    imageCount: input.imageCount,
    editComments: [],
    bucket: input.bucket,
    uploadPath: input.uploadPath,
    description: input.description,
  };
}

/** Serialize `UploadMeta.json` exactly as the live file: 2-space, LF, no trailing newline. */
export function serializeUploadMeta(meta: UploadMetaJson): string {
  return JSON.stringify(meta, null, 2);
}

// ---------------------------------------------------------------------------
// UploadComplete.json — this project's own completion sentinel (additive; not
// read by upstream SPARC'd, which keys completion off UploadMeta.json). Blobs
// live under the upload prefix, so there is no separate blob prefix to record.
// ---------------------------------------------------------------------------

export type UploadCompleteFile = { media_path: string; size: number; sha256: string };

export type UploadCompleteJson = {
  schemaVersion: 1;
  uploadPath: string;
  fileCount: number;
  metadataBundleSha256: string;
  files: UploadCompleteFile[];
  completedAt: string;
};

export function serializeUploadComplete(c: UploadCompleteJson): string {
  return JSON.stringify(c, null, 2);
}

// ===========================================================================
// v016 readers + tagger merge helpers (added for sparcd-tagger, P0).
//
// The writers above are the byte-shape contract; everything below is the
// inverse plus the surgical merge the tagger needs. Two hard rules drive the
// design:
//
//   1. Round-trip stability. `serializeCsvRows(parseCsvRows(s))` reproduces a
//      writer-shaped string byte-for-byte, so a merge that only touches edited
//      rows leaves every other byte untouched.
//   2. Preserve unrelated data. Merge operates on *raw* string rows, never on
//      the typed view, so columns this package doesn't model (taxon_id,
//      behaviour, count_new, …) and rows for images the tagger never touched
//      survive a sync exactly as Java / sparcd-web wrote them.
// ===========================================================================

// --- Low-level CSV ---------------------------------------------------------

/**
 * Tokenize CSV text into raw rows of fields. Handles the writer's QUOTE_ALL
 * output (every field quoted, `""` escaping, LF rows) *and* the looser shapes
 * seen in live Java / sparcd-web files (bare fields, embedded commas/newlines
 * inside quotes, stray CR). Truly empty lines are dropped; a quoted empty
 * field (`""`) is preserved. Empty input → `[]`.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false; // any char (incl. a quote) seen in the current row

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      sawAny = true;
    } else if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      endField();
      sawAny = true;
    } else if (ch === '\n') {
      if (sawAny) endRow();
      else {
        field = '';
        row = [];
      }
    } else if (ch === '\r') {
      // tolerate CRLF — drop the CR
    } else {
      field += ch;
      sawAny = true;
    }
  }
  if (sawAny || field !== '' || row.length > 0) endRow();
  return rows;
}

/** Serialize raw rows with the writer's QUOTE_ALL + LF policy (inverse of `parseCsvRows`). */
export function serializeCsvRows(rows: string[][]): string {
  return rows.map(csvRow).join('');
}

// Fixed-position column indices — the v016 contract. Readers/merge reference
// these names instead of magic numbers; the writer above is their source.
export const MEDIA_COL = {
  mediaId: 0,
  deploymentId: 1,
  sequenceId: 2,
  captureMethod: 3,
  timestamp: 4,
  filePath: 5,
  fileName: 6,
  mediaType: 7,
  exif: 8,
  favorite: 9,
  comments: 10,
} as const;

export const OBS_COL = {
  observationId: 0,
  deploymentId: 1,
  sequenceId: 2,
  mediaId: 3,
  timestamp: 4,
  observationType: 5,
  cameraSetup: 6,
  taxonId: 7,
  scientificName: 8,
  count: 9,
  countNew: 10,
  lifeStage: 11,
  sex: 12,
  behaviour: 13,
  individualId: 14,
  classificationMethod: 15,
  classifiedBy: 16,
  classificationTimestamp: 17,
  classificationConfidence: 18,
  comments: 19,
} as const;

export const DEPLOY_COL = {
  deploymentId: 0,
  locationId: 1,
  locationName: 2,
  longitude: 3,
  latitude: 4,
  cameraHeight: 12,
} as const;

export const OBS_COLUMN_COUNT = 20;
export const MEDIA_COLUMN_COUNT = 11;
export const DEPLOY_COLUMN_COUNT = 23;

// --- Typed readers ---------------------------------------------------------

/** Parse `deployments.csv` into typed rows (note: longitude precedes latitude). */
export function parseDeployments(csv: string): Deployment[] {
  return parseCsvRows(csv).map((r) => ({
    deploymentId: r[DEPLOY_COL.deploymentId] ?? '',
    locationId: r[DEPLOY_COL.locationId] ?? '',
    locationName: r[DEPLOY_COL.locationName] ?? '',
    longitude: Number(r[DEPLOY_COL.longitude]),
    latitude: Number(r[DEPLOY_COL.latitude]),
    elevation: Number(r[DEPLOY_COL.cameraHeight]),
  }));
}

/** Parse `media.csv` into typed rows. `mediaPath` is the full object key (col 0). */
export function parseMedia(csv: string): Media[] {
  return parseCsvRows(csv).map((r) => ({
    mediaId: r[MEDIA_COL.mediaId] ?? '',
    deploymentId: r[MEDIA_COL.deploymentId] ?? '',
    mediaPath: r[MEDIA_COL.mediaId] ?? '',
    fileName: r[MEDIA_COL.fileName] ?? '',
    timestamp: r[MEDIA_COL.timestamp] ?? '',
    mimeType: r[MEDIA_COL.mediaType] ?? '',
    comments: r[MEDIA_COL.comments] ?? '',
  }));
}

/** Parse `observations.csv` into typed rows. `tags` is the raw col-19 comments. */
export function parseObservations(csv: string): Observation[] {
  return parseCsvRows(csv).map((r) => {
    const rawType = r[OBS_COL.observationType] ?? '';
    return {
      observationId: r[OBS_COL.observationId] ?? '',
      mediaId: r[OBS_COL.mediaId] ?? '',
      deploymentId: r[OBS_COL.deploymentId] ?? '',
      timestamp: r[OBS_COL.timestamp] ?? '',
      observationType: rawType === 'animal' ? 'animal' : 'blank',
      scientificName: r[OBS_COL.scientificName] ?? '',
      count: Number(r[OBS_COL.count] ?? '0'),
      tags: r[OBS_COL.comments] ?? '',
    };
  });
}

// --- Tag marker grammar ----------------------------------------------------

export type TagMarker = { prefix: string; value: string };

/** Reserved prefixes for v0. Unknown prefixes are tolerated and preserved. */
export const TIMESTAMP_PREFIX = 'TIMESTAMP';
export function buildMediaComments(input: { timestampSource?: TimestampSource }): string {
  return input.timestampSource ? serializeTagMarkers([{ prefix: TIMESTAMP_PREFIX, value: input.timestampSource }]) : '';
}

export function timestampSourceFromComments(comments: string): TimestampSource | null {
  const value = parseTagMarkers(comments).find((m) => m.prefix === TIMESTAMP_PREFIX)?.value;
  return value === 'manual' || value === 'spread' || value === 'interpolated' || value === 'offset' || value === 'file-modified' ? value : null;
}

export const COMMONNAME_PREFIX = 'COMMONNAME';
export const REQUESTED_SPECIES_PREFIX = 'REQUESTED_SPECIES';

// `[PREFIX:value]` markers concatenated in the col-19 comments field. Prefixes
// are upper snake; values run to the next `]`.
const MARKER_RE = /\[([A-Z0-9_]+):([^\]]*)\]/g;

export function parseTagMarkers(comments: string): TagMarker[] {
  const out: TagMarker[] = [];
  for (const m of comments.matchAll(MARKER_RE)) out.push({ prefix: m[1], value: m[2] });
  return out;
}

export function serializeTagMarkers(markers: TagMarker[]): string {
  return markers.map((m) => `[${m.prefix}:${m.value}]`).join('');
}

/** First `[COMMONNAME:…]` value, or null. */
export function commonNameFromComments(comments: string): string | null {
  const m = parseTagMarkers(comments).find((t) => t.prefix === COMMONNAME_PREFIX);
  return m ? m.value : null;
}

/** First `[REQUESTED_SPECIES:…]` value, or null. */
export function requestedSpeciesFromComments(comments: string): string | null {
  const m = parseTagMarkers(comments).find((t) => t.prefix === REQUESTED_SPECIES_PREFIX);
  return m ? m.value : null;
}

/**
 * Build the col-19 comments string for one observation. `commonName` and
 * `requestedSpecies` land as reserved markers; `extra` carries through any
 * markers a future tool added so this writer never strips them.
 */
export function buildObservationComments(input: {
  commonName?: string;
  requestedSpecies?: string;
  extra?: TagMarker[];
}): string {
  const markers: TagMarker[] = [];
  if (input.commonName) markers.push({ prefix: COMMONNAME_PREFIX, value: input.commonName });
  if (input.requestedSpecies)
    markers.push({ prefix: REQUESTED_SPECIES_PREFIX, value: input.requestedSpecies });
  if (input.extra) markers.push(...input.extra);
  return serializeTagMarkers(markers);
}

// --- Tagger merge ----------------------------------------------------------

/** One species/label applied to an image (a SPARC'd observation is species + count only). */
export type ObservationInput = {
  scientificName: string; // col 8 (e.g. "Canis latrans", "Casper" for Ghost)
  count: number; // col 9
  commonName?: string; // → [COMMONNAME:…] in col 19
  requestedSpecies?: string; // → [REQUESTED_SPECIES:…] in col 19
  extraMarkers?: TagMarker[]; // preserved through-markers
};

/**
 * The full edited state for one image. `observations` is the *complete*
 * replacement set for this media id — `[]` means detag. `timestamp` stamps new
 * observation rows (col 4); `mediaTimestamp`, when set, also rewrites the
 * media row's col 4 (a synced time correction).
 */
export type MediaEdit = {
  mediaId: string; // full object key, = media.csv col 0 / observations col 3
  deploymentId: string;
  timestamp: string; // ISO stamped on new observation rows
  mediaTimestamp?: string; // if set, overwrite media.csv col 4 for this image
  observations: ObservationInput[];
};

/** Default observation-id scheme for tagger-created rows (deterministic; readers key on media id, not this). */
export const defaultObservationId = (mediaId: string, index: number): string =>
  `${mediaId}:${index}`;

// Drop zero/negative-count observations exactly as sparcd-web does before a row
// is considered "species present".
const positiveCount = (o: ObservationInput): boolean => o.count > 0;

function buildObservationRow(
  edit: MediaEdit,
  o: ObservationInput,
  observationId: string,
): string[] {
  const row = new Array<string>(OBS_COLUMN_COUNT).fill('');
  row[OBS_COL.observationId] = observationId;
  row[OBS_COL.deploymentId] = edit.deploymentId;
  row[OBS_COL.mediaId] = edit.mediaId;
  row[OBS_COL.timestamp] = edit.timestamp;
  row[OBS_COL.observationType] = 'animal';
  row[OBS_COL.cameraSetup] = 'false';
  row[OBS_COL.scientificName] = o.scientificName;
  row[OBS_COL.count] = String(o.count);
  row[OBS_COL.countNew] = '0';
  row[OBS_COL.comments] = buildObservationComments({
    commonName: o.commonName,
    requestedSpecies: o.requestedSpecies,
    extra: o.extraMarkers,
  });
  return row;
}

function buildBlankObservationRow(edit: MediaEdit, observationId: string): string[] {
  const row = new Array<string>(OBS_COLUMN_COUNT).fill('');
  row[OBS_COL.observationId] = observationId;
  row[OBS_COL.deploymentId] = edit.deploymentId;
  row[OBS_COL.mediaId] = edit.mediaId;
  row[OBS_COL.timestamp] = edit.timestamp;
  row[OBS_COL.observationType] = 'blank';
  row[OBS_COL.cameraSetup] = 'false';
  return row;
}

/**
 * Merge time corrections into `media.csv`. Only rows whose media id appears in
 * an edit with a `mediaTimestamp` are touched (col 4); every other byte —
 * including media rows for un-edited images — is preserved.
 */
export function mergeMedia(canonicalMediaCsv: string, edits: MediaEdit[]): string {
  const newTs = new Map<string, string>();
  for (const e of edits) if (e.mediaTimestamp !== undefined) newTs.set(e.mediaId, e.mediaTimestamp);
  if (newTs.size === 0) return canonicalMediaCsv;
  const rows = parseCsvRows(canonicalMediaCsv);
  for (const row of rows) {
    const ts = newTs.get(row[MEDIA_COL.mediaId]);
    if (ts !== undefined) row[MEDIA_COL.timestamp] = ts;
  }
  return serializeCsvRows(rows);
}

export type MergeObservationsOptions = {
  observationId?: (mediaId: string, index: number) => string;
};

/**
 * Merge tagger edits into `observations.csv`. For each edited media id, all
 * existing rows are removed and replaced by the edit's positive-count
 * observations; unrelated media keep their rows untouched and in order. New
 * rows take the slot of that media's first existing row, or append (in edit
 * order) when the image had none. Zero-count rows are dropped (sparcd-web
 * parity); when the resulting set is empty a blank placeholder row is written
 * so every media file retains exactly one row (one-row-per-file contract).
 */
export function mergeObservations(
  canonicalObsCsv: string,
  edits: MediaEdit[],
  opts: MergeObservationsOptions = {},
): string {
  const genId = opts.observationId ?? defaultObservationId;
  const editByMedia = new Map(edits.map((e) => [e.mediaId, e]));
  const built = new Map<string, string[][]>();
  for (const e of edits) {
    const positive = e.observations
      .filter(positiveCount)
      .map((o, i) => buildObservationRow(e, o, genId(e.mediaId, i)));
    built.set(
      e.mediaId,
      positive.length > 0 ? positive : [buildBlankObservationRow(e, genId(e.mediaId, 0))],
    );
  }

  const rows = parseCsvRows(canonicalObsCsv);
  const out: string[][] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const mediaId = row[OBS_COL.mediaId];
    if (!editByMedia.has(mediaId)) {
      out.push(row);
      continue;
    }
    // First time we hit this edited media, splice in its replacement rows.
    if (!placed.has(mediaId)) {
      out.push(...(built.get(mediaId) ?? []));
      placed.add(mediaId);
    }
    // Subsequent canonical rows for this media are dropped (replaced).
  }
  // Edited media that had no canonical rows: append in edit order.
  for (const e of edits) {
    if (!placed.has(e.mediaId)) {
      out.push(...(built.get(e.mediaId) ?? []));
      placed.add(e.mediaId);
    }
  }
  return serializeCsvRows(out);
}

// --- UploadMeta.json delta -------------------------------------------------

/** True when an image counts as "species present" (≥1 positive-count row).
 *  Placeholder rows (`count: undefined`) never count. Exported as the one
 *  definition of `imagesWithSpecies`, so producers can't drift from the sync
 *  delta. */
export function hasSpeciesPresent(observations: { count?: number }[]): boolean {
  return observations.some((o) => (o.count ?? 0) > 0);
}

export type SpeciesDelta = { detagged: number; retagged: number };

/**
 * Java's `imagesWithSpecies` delta, computed from the edited media only (not a
 * full recompute): detagged = was species-present, now empty; retagged = was
 * empty, now species-present. Ghost/Casper counts as species-present.
 */
export function computeSpeciesDelta(canonicalObsCsv: string, edits: MediaEdit[]): SpeciesDelta {
  const before = parseObservations(canonicalObsCsv);
  const byMedia = new Map<string, Observation[]>();
  for (const o of before) {
    const arr = byMedia.get(o.mediaId) ?? [];
    arr.push(o);
    byMedia.set(o.mediaId, arr);
  }
  let detagged = 0;
  let retagged = 0;
  for (const e of edits) {
    const wasPresent = hasSpeciesPresent(byMedia.get(e.mediaId) ?? []);
    const nowPresent = hasSpeciesPresent(e.observations);
    if (wasPresent && !nowPresent) detagged++;
    else if (!wasPresent && nowPresent) retagged++;
  }
  return { detagged, retagged };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Java's `uuuu.MM.dd.HH.mm.ss` edit-comment timestamp (local time). */
export function javaEditStamp(d: Date): string {
  return (
    `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}.` +
    `${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`
  );
}

/**
 * Apply a tagger sync to `UploadMeta.json`: shift `imagesWithSpecies` by the
 * Java delta (`prior - detagged + retagged`) and append the mandatory
 * `Edited by <user> on <stamp>` comment. Existing keys keep their position, so
 * the serialized bytes stay aligned with the live shape.
 */
export function applyUploadMetaEdit(
  meta: UploadMetaJson,
  input: { delta: SpeciesDelta; user: string; editStamp: string },
): UploadMetaJson {
  // Older/foreign UploadMeta.json (Java, pre-editComments) may omit the field;
  // parseUploadMeta is a bare cast, so default it before spreading.
  const prior = Array.isArray(meta.editComments) ? meta.editComments : [];
  return {
    ...meta,
    imagesWithSpecies: meta.imagesWithSpecies - input.delta.detagged + input.delta.retagged,
    editComments: [...prior, `Edited by ${input.user} on ${input.editStamp}`],
  };
}

/** Parse `UploadMeta.json` text (shape is the live file; key order ignored on read). */
export function parseUploadMeta(text: string): UploadMetaJson {
  return JSON.parse(text) as UploadMetaJson;
}

// --- Time correction -------------------------------------------------------

/** Signed offset applied to every image in an upload (mirrors Java TimeShift). */
export type TimeOffset = {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

export const ZERO_OFFSET: TimeOffset = {
  years: 0,
  months: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
};

// Parse the leading `YYYY-MM-DDTHH:mm:ss` fields out of either a naive string
// (legacy data) or a full ISO 8601 UTC string (current writer output) — the
// trailing `.sssZ`, if present, is ignored by the arithmetic below and dropped
// from the output, which is always re-emitted as full ISO.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** Last valid day of `month0` (0-11) in `year` — for calendar-style day clamping. */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Shift a timestamp (naive or full ISO) by a signed offset, returning a full
 * ISO 8601 UTC string. Non-matching input is returned unchanged.
 *
 * Mirrors `LocalDateTime.plusYears(y).plusMonths(mo).plusDays(d).plusHours(h)...`
 * semantics carried over from the original desktop tooling: the year and month
 * steps **clamp** the day-of-month to the last valid day (Jan 31 + 1mo → Feb
 * 28/29) rather than overflowing into the next month, and the two clamps are
 * **sequential** (plusYears clamps before plusMonths). The day/hour/minute/second
 * steps are exact durations. See the `contracts.test.ts` "clamps month/year
 * overflow" case.
 */
export function shiftTimestamp(iso: string, off: TimeOffset): string {
  const m = TS_RE.exec(iso);
  if (!m) return iso;
  let year = Number(m[1]);
  let month0 = Number(m[2]) - 1;
  let day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  // plusYears — clamp the day within the same month of the new year.
  year += off.years;
  day = Math.min(day, daysInMonth(year, month0));
  // plusMonths — carry into years, then clamp the day to the resulting month.
  const totalMonths = month0 + off.months;
  year += Math.floor(totalMonths / 12);
  month0 = ((totalMonths % 12) + 12) % 12;
  day = Math.min(day, daysInMonth(year, month0));

  // plusDays/Hours/Minutes/Seconds — exact durations from the clamped instant.
  const d = new Date(
    Date.UTC(year, month0, day, hour, minute, second) +
      off.days * 86_400_000 +
      off.hours * 3_600_000 +
      off.minutes * 60_000 +
      off.seconds * 1_000,
  );
  return d.toISOString();
}

/** Resolve the corrected timestamp for one image: per-image override wins over the upload offset. */
export function correctedTimestamp(
  original: string,
  offset: TimeOffset | null,
  override: string | null,
): string {
  if (override) return override;
  if (offset) return shiftTimestamp(original, offset);
  return original;
}

// --- Validators ------------------------------------------------------------

/**
 * Coordinate sanity check. Latitude/longitude are easy to transpose, so a
 * latitude outside [-90, 90] that *would* be valid as a longitude is flagged
 * specifically. Returns a human reason, or null when both are in range.
 */
export function validateCoordinates(latitude: number, longitude: number): string | null {
  const latOk = latitude >= -90 && latitude <= 90;
  const lngOk = longitude >= -180 && longitude <= 180;
  if (latOk && lngOk) return null;
  if (!latOk && Math.abs(latitude) <= 180 && Math.abs(longitude) <= 90) {
    return 'latitude/longitude look transposed';
  }
  if (!latOk) return `latitude ${latitude} out of [-90, 90]`;
  return `longitude ${longitude} out of [-180, 180]`;
}

/** Assert a parsed CSV has the expected fixed column count on every row. */
export function validateColumnCount(rows: string[][], expected: number): string | null {
  const bad = rows.findIndex((r) => r.length !== expected);
  if (bad === -1) return null;
  return `row ${bad} has ${rows[bad].length} columns, expected ${expected}`;
}
