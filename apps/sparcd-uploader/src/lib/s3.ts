// The app's single point of contact with `@sparcd/s3-safe`. This is a static
// BYO-S3 app: bucket access is discovered at runtime from the connected
// credentials, not baked into the JS bundle. IAM/CORS and the wrapper's
// append-only methods are the real safety boundaries.

import {
  SafeS3Client,
  listCollections as listCollectionsWith,
  parseCollectionKey,
  translateReadError,
  type CollectionRef,
} from '@sparcd/s3-safe';
import type { S3Config } from '@sparcd/types';
import { parseUploadMeta, type UploadMetaJson } from '@sparcd/camtrap';
import { LOCATIONS_KEY, parseLocations, type LocationsParse } from './locations';
import { sha256Hex } from './hash';
import type { EditCanonical, EditIO, EditRole } from './publishedEdit';

const SPECIES_KEY = 'Settings/species.json';

// Client-side bucket allowlists are not a security boundary in a static app.
// They exist only because the wrapper requires an explicit scope; the connected
// user's IAM policy and bucket CORS decide what the app can actually touch.
const RUNTIME_BUCKET_SCOPE = ['*'];

// Optional accident guard for dev/testing: when set (comma-separated bucket
// names), every write outside the list throws client-side before a byte moves.
// Useful when the connected credential is broader than the buckets the session
// should touch — e.g. testing against a shared object store with a
// project-wide key. Reads stay unrestricted so discovery keeps working.
const WRITE_SCOPE =
  (import.meta.env.VITE_SPARCD_S3_WRITE_SCOPE as string | undefined)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? RUNTIME_BUCKET_SCOPE;

// Cache the client for the active connection object only. This preserves the
// UX benefit of SDK client reuse while avoiding stale credential reuse after a
// reconnect, and it does not put raw secrets into cache keys.
let cached: { config: S3Config; client: SafeS3Client } | null = null;

export function clearClientCache(): void {
  cached = null;
}

export function getClient(cfg: S3Config): SafeS3Client {
  if (cached?.config === cfg) return cached.client;
  const client = new SafeS3Client(cfg, RUNTIME_BUCKET_SCOPE, WRITE_SCOPE);
  cached = { config: cfg, client };
  return client;
}

function settingsRank(bucket: string): number {
  if (bucket.startsWith('sparcd-settings-')) return 0;
  if (bucket === 'sparcd') return 1;
  return 2;
}

// A store can expose a hundred-plus buckets. Probing them all at once is what
// the app used to do, and on a fast path it is genuinely the quickest way to
// get an answer — but it also claims the whole connection pool for a probe,
// which is the same pool the blob lanes need. Chunks trade some of that cold
// wall time back for a bounded footprint; measured on a 129-bucket store, the
// sweep went from 129 requests in one wave to 65 in five. The cache is what
// makes that trade cheap: a store is only swept once.
const PROBE_CONCURRENCY = 16;

/**
 * First bucket in `buckets` order carrying the marker, or null. Chunked so the
 * winner is the earliest in the caller's preference order and not merely the
 * one whose probe came back first.
 */
async function firstBucketWithMarker(
  client: SafeS3Client,
  buckets: string[],
  marker = LOCATIONS_KEY,
): Promise<string | null> {
  for (let i = 0; i < buckets.length; i += PROBE_CONCURRENCY) {
    const chunk = buckets.slice(i, i + PROBE_CONCURRENCY);
    const hits = await Promise.all(
      chunk.map((bucket) => client.statObject(bucket, marker).then(() => true, () => false)),
    );
    const at = hits.indexOf(true);
    if (at >= 0) return chunk[at];
  }
  return null;
}

/**
 * Find the bucket holding `Settings/locations.json`. Name preferences keep
 * official SPARC'd buckets first, but any readable bucket with the marker works
 * for BYO-S3 deployments.
 *
 * `hint` is a previously discovered bucket: one HEAD confirms it and skips the
 * search entirely. A hint that no longer answers falls through to the full
 * probe rather than failing the connect.
 */
export async function discoverSettingsBucket(
  client: SafeS3Client,
  hint?: string,
): Promise<string> {
  if (hint && (await firstBucketWithMarker(client, [hint]))) return hint;

  const buckets = (await client.listBuckets()).sort(
    (a, b) => settingsRank(a) - settingsRank(b) || a.localeCompare(b),
  );
  // An official deployment keeps its settings in `sparcd-settings-<uuid>` or
  // the legacy `sparcd`, so asking those two first answers it in one request.
  // A BYO-S3 store that keeps them anywhere else pays those two and then the
  // ordered sweep, which still stops at the first hit rather than reading the
  // whole store — measured on a 129-bucket store whose marker sits midway
  // through the alphabet, 81 HEADs instead of 129.
  const conventional = buckets.filter((b) => settingsRank(b) < 2);
  const rest = buckets.filter((b) => settingsRank(b) === 2);
  const found =
    (await firstBucketWithMarker(client, conventional)) ??
    (await firstBucketWithMarker(client, rest));
  if (found) return found;

  throw new Error(
    `No readable settings bucket found. The connected credentials must be able to HEAD/GET "${LOCATIONS_KEY}" in one visible bucket, and that bucket must allow this web origin via CORS.`,
  );
}

export type LocationsResult = LocationsParse & { settingsBucket: string };

/**
 * Read + parse the location registry. Network/CORS failures surface as a
 * `Failed to fetch`-style error with no HTTP status, so we translate the
 * common cases into actionable messages — this is the "validate browser CORS
 * read behavior" surface for P2.
 */
export async function fetchLocations(
  cfg: S3Config,
  settingsBucketHint?: string,
): Promise<LocationsResult> {
  const client = getClient(cfg);
  const settingsBucket = await discoverSettingsBucket(client, settingsBucketHint);
  let bytes: Uint8Array;
  try {
    bytes = await client.getObject(settingsBucket, LOCATIONS_KEY);
  } catch (err) {
    throw translateReadError(err, `"${LOCATIONS_KEY}" in bucket "${settingsBucket}"`);
  }
  const text = new TextDecoder().decode(bytes);
  const parsed = parseLocations(text);
  return { ...parsed, settingsBucket };
}

export type SpeciesKeyConfig = {
  scientificName: string;
  commonName: string;
  keyBinding: string | null;
};

/** Read only the species fields needed for the shared keybinding profile check. */
export async function fetchSpeciesKeyConfig(cfg: S3Config): Promise<SpeciesKeyConfig[]> {
  const client = getClient(cfg);
  const buckets = (await client.listBuckets()).sort(
    (a, b) => settingsRank(a) - settingsRank(b) || a.localeCompare(b),
  );
  const settingsBucket = await firstBucketWithMarker(client, buckets, SPECIES_KEY);
  if (!settingsBucket) throw new Error(`No readable settings bucket contains "${SPECIES_KEY}"`);
  const bytes = await client.getObject(settingsBucket, SPECIES_KEY);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected "${SPECIES_KEY}" to contain an array`);
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.scientificName !== 'string' || !value.scientificName.trim()) return [];
    return [{
      scientificName: value.scientificName.trim(),
      commonName:
        typeof value.name === 'string' && value.name.trim()
          ? value.name.trim()
          : value.scientificName.trim(),
      keyBinding: typeof value.keyBinding === 'string' ? value.keyBinding : null,
    }];
  });
}

// Collection discovery, keying, and the `CollectionRef` shape live in
// `@sparcd/s3-safe` (shared with the tagger). We re-export them through this
// facade and keep the `cfg`-based entry so callers stay on the local client.
export { parseCollectionKey, type CollectionRef };

export function listCollections(cfg: S3Config): Promise<CollectionRef[]> {
  return listCollectionsWith(getClient(cfg));
}

// Split one CSV line into fields. The live `deployments.csv` files are wildly
// inconsistent — some rows are fully quoted (with `""` escaping), others are
// bare — so we parse both forms rather than assume quoting.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

// Pull the deployed location ids out of a header-less `deployments.csv`.
// location_id is column 1, but it's sometimes stored as the full
// `<collection-uuid>:<location-id>` form, so we keep only the trailing id. The
// `0000` "cleared coordinates" sentinel is dropped, matching the explorer.
function deploymentLocationIds(csv: string): string[] {
  const ids: string[] = [];
  for (const line of csv.split('\n')) {
    if (!line.trim()) continue;
    const raw = parseCsvLine(line)[1]?.trim();
    if (!raw) continue;
    const id = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
    if (id && id !== '0000') ids.push(id);
  }
  return ids;
}

/**
 * The location ids a collection has actually deployed, read from each upload's
 * `Collections/<uuid>/Uploads/<upload>/deployments.csv`. Upload folders are
 * enumerated with a delimiter (no image walk), then one small GET per upload.
 */
export async function listCollectionDeploymentLocationIds(
  cfg: S3Config,
  ref: CollectionRef,
): Promise<string[]> {
  const client = getClient(cfg);
  const uploadDirs = await client.listCommonPrefixes(ref.bucket, `Collections/${ref.uuid}/Uploads/`);
  const ids = new Set<string>();
  await Promise.all(
    uploadDirs.map(async (dir) => {
      try {
        const bytes = await client.getObject(ref.bucket, `${dir}deployments.csv`);
        for (const id of deploymentLocationIds(new TextDecoder().decode(bytes))) ids.add(id);
      } catch {
        // Upload without a deployments.csv yet, or unreadable / CORS-blocked.
      }
    }),
  );
  return [...ids];
}

// --- Edit-after-publish (Stage B) ------------------------------------------
//
// The read + write S3 surface for correcting a published upload. The same
// `getClient` is used for reads and writes (its write scope is already granted,
// line 32), so the edit IO physically can issue a `replaceIfUnchanged`. A
// dry-run never calls the write closures, so it touches nothing.

const EDIT_FILE: Record<EditRole, string> = {
  deployments: 'deployments.csv',
  media: 'media.csv',
  observations: 'observations.csv',
  uploadMeta: 'UploadMeta.json',
};

/** Load one canonical object with its ETag + content hash (the edit ground). */
async function loadEditObject(
  client: SafeS3Client,
  bucket: string,
  key: string,
  what: string,
): Promise<{ text: string; etag: string; hash: string }> {
  try {
    // HEAD first for the ETag, then GET the bytes. A concurrent change between
    // the two only risks a spurious conflict (safe-fail) — the write re-checks
    // IfMatch — never a bad write.
    const stat = await client.statObject(bucket, key);
    const bytes = await client.getObject(bucket, key);
    return { text: new TextDecoder().decode(bytes), etag: stat.etag ?? '', hash: await sha256Hex(bytes) };
  } catch (err) {
    throw translateReadError(err, what);
  }
}

/** Read a published upload's canonical files (bytes + etag + hash) for grounding an edit. */
export async function loadPublishedCanonical(
  cfg: S3Config,
  bucket: string,
  uploadPrefix: string,
  roles: EditRole[],
): Promise<EditCanonical> {
  const client = getClient(cfg);
  const entries = await Promise.all(
    roles.map(async (role) => {
      const file = EDIT_FILE[role];
      return [role, await loadEditObject(client, bucket, `${uploadPrefix}${file}`, file)] as const;
    }),
  );
  return Object.fromEntries(entries) as EditCanonical;
}

export type UploadMetaRead = { meta: UploadMetaJson; etag: string; hash: string; text: string };

/** Read `UploadMeta.json` for the description-edit form prefill + its base ETag/hash. */
export async function readUploadMeta(
  cfg: S3Config,
  bucket: string,
  uploadPrefix: string,
): Promise<UploadMetaRead> {
  const loaded = await loadEditObject(getClient(cfg), bucket, `${uploadPrefix}UploadMeta.json`, 'UploadMeta.json');
  return { meta: parseUploadMeta(loaded.text), etag: loaded.etag, hash: loaded.hash, text: loaded.text };
}

/**
 * Assemble the injected `EditIO` for one published upload. The write closures
 * go through `getClient(cfg)` (write-scoped), but a dry-run calls neither, so a
 * dry-run never writes a byte — not even a snapshot.
 */
export function makeEditIO(cfg: S3Config, bucket: string, uploadPrefix: string): EditIO {
  return {
    loadCanonical: (roles) => loadPublishedCanonical(cfg, bucket, uploadPrefix, roles),
    writeSnapshot: async (key, body, contentType) => {
      await getClient(cfg).writeImmutable(bucket, key, body, { contentType });
    },
    replace: (key, body, etag, contentType) =>
      getClient(cfg).replaceIfUnchanged(bucket, key, body, { etag, contentType }),
    now: () => new Date(),
  };
}

export type PublishedUpload = {
  prefix: string; // full `Collections/<uuid>/Uploads/<stamp>/`
  stamp: string;
  meta: UploadMetaJson;
  /** The current single deployment_id from `deployments.csv` col 0, if present. */
  deploymentId: string | null;
};

/**
 * List the published uploads of a collection for the management UI: each
 * upload's `UploadMeta.json` (description + tally) and its current deployment_id.
 * One small GET per upload; an upload missing either file is skipped.
 */
export async function listPublishedUploads(cfg: S3Config, ref: CollectionRef): Promise<PublishedUpload[]> {
  const client = getClient(cfg);
  const uploadDirs = await client.listCommonPrefixes(ref.bucket, `Collections/${ref.uuid}/Uploads/`);
  const out = await Promise.all(
    uploadDirs.map(async (prefix): Promise<PublishedUpload | null> => {
      try {
        const metaBytes = await client.getObject(ref.bucket, `${prefix}UploadMeta.json`);
        const meta = parseUploadMeta(new TextDecoder().decode(metaBytes));
        let deploymentId: string | null = null;
        try {
          const depText = new TextDecoder().decode(await client.getObject(ref.bucket, `${prefix}deployments.csv`));
          deploymentId = parseCsvLine(depText.split('\n').find((l) => l.trim()) ?? '')[0]?.trim() || null;
        } catch {
          // No deployments.csv — leave deploymentId null.
        }
        return { prefix, stamp: prefix.replace(/\/$/, '').split('/').pop() ?? prefix, meta, deploymentId };
      } catch {
        return null; // No UploadMeta.json yet, or unreadable / CORS-blocked.
      }
    }),
  );
  return out
    .filter((u): u is PublishedUpload => u !== null)
    .sort((a, b) => b.stamp.localeCompare(a.stamp)); // newest first
}
