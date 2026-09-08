# sparcd-tagger — implementation plan

A static, browser-based tagging interface for SPARC'd camera-trap images.
Tags persist locally in IndexedDB and sync to S3-compatible storage as
canonical Camtrap-DP metadata updates under each upload prefix.

Sits alongside SPARC'd; reads the same MinIO/R2/S3 buckets the upstream
readers use, and produces the same row/column `observations.csv` shape (the
v016 20-column layout — see Camtrap-DP encoding). It is a replacement/add-on
for the taggers in `sparcd-web` and the `sparcd` Java app. Compatibility is
the primary contract: a user can tag an image in this tool, open and re-tag
that same image in the Java app, then preview/query it in `sparcd-web` or the
static marimo notebook. Therefore S3 sync updates the canonical upload-level
`media.csv`, `observations.csv`, and `UploadMeta.json` that those tools already
read. Versioned append-only copies are allowed for audit/recovery, but they are
not the compatibility output.

> **How the upstream readers surface species — and why sidecars don't work.**
> The `sparcd-web` reader (`get_s3_images` in `server/s3/s3_access_helpers.py`)
> **lists image objects under the upload prefix, presigns the listed key, then
> decorates each image from the canonical upload-level `media.csv` and
> `observations.csv`, matched on the full object key.** It never reads a
> per-user sidecar like `<uploadPrefix>/observations/<userId>/<ISO>.csv`. The
> Java app (`Camtrap.saveTo` + `S3ConnectionManager.saveImages`) reads and
> **overwrites** canonical `deployments.csv`, `media.csv`, `observations.csv`,
> and `UploadMeta.json` in place. So append-only sidecars are invisible to both
> existing tools: **canonical replacement is the only output that shows up.** Do
> not redesign this toward sidecar-only writes.

## Source References

These are the upstream and in-repo sources behind the contracts in this plan.
Read them to confirm or extend any data-shape decision — cite by symbol, not
line number, since both repos move.

To read an upstream file, prefer the GitHub CLI for targeted lookups —
`gh api repos/<org>/<repo>/contents/<path> --jq .content | base64 -d`, piped
through `grep`/`sed` so only the lines you need enter context. If you need to
trace a behavior across many files, check the repo out into a **gitignored
workspace dir** (e.g. a sibling `../sparcd` / `../sparcd-web`, or `.reference/`)
and remove it when done — **do not clone into `/tmp`**.

- **This monorepo** — `https://github.com/culverlab/sparcd-rewrite` if the
  implementer is not already in a checkout. Local paths in this plan are
  relative to the monorepo root.
- **Java desktop tagger** — `https://github.com/culverlab/sparcd`. Canonical
  save path: `S3ConnectionManager.saveImages`,
  `S3ConnectionManager.addUpdateMetadataCamtrap`, `Camtrap.saveTo`
  (`model/image/Camtrap.java`), and the v016 column models in
  `model/image/Media.java` / `Deployments.java` / `Observations.java`.
- **Web reader** — `https://github.com/culverlab/sparcd-web` (a sibling
  checkout, if one exists, is usually at `../sparcd-web`). `get_s3_images`,
  `apply_media_timestamps`, and `apply_observation_species` in
  `server/s3/s3_access_helpers.py` define the list-under-prefix + decorate
  behavior.
- **Static marimo explorer** — `apps/sparcd-explorer/` in this monorepo, when
  present. Treat it as another reader of canonical upload-level Camtrap CSVs,
  not as the compatibility baseline when it disagrees with Java.
- **Uploader (this monorepo)** — `apps/sparcd-uploader/`. The sibling tool that
  established the shared packages and the patterns this plan reuses: runtime
  bucket discovery + `connectionId` cache keying (`src/lib/s3.ts`), the resumable
  upload journal (`src/lib/upload.ts`), and the v016 writers/shapes
  (`packages/camtrap/src/index.ts`). Read `apps/sparcd-uploader/README.md`,
  `apps/sparcd-uploader/plan.md`, and the actual uploader source together; if
  they disagree, treat the source code and tests as the current behavior.
- **Shared design system** — `docs/design-system-field-notebook.md` and the
  existing uploader UI in `apps/sparcd-uploader/src/`.

No implementation step may rely on this chat thread, a prior Claude thread, or
memory of the uploader build. If a behavior matters, it must be recoverable from
the sources above, this plan, a fixture, or a test.

## Design References

The external design bundle is the source of truth for layout, copy, and
component behavior when it is accessible; this plan is the source of truth for
data, safety, and persistence contracts. Read both side-by-side. If the design
URL is unavailable, continue with the Field Notebook design system and the
existing uploader UI as the local visual baseline rather than blocking data
contract work.

- **Latest Claude Design bundle** (Tagger, post rev-4 — time correction +
  simplified login):
  <https://api.anthropic.com/v1/design/h/13csaw3-7eZU_pYtJkQGwQ?open_file=SPARCd+Tagger.html>
  Each iteration produces a new URL; update this entry when a newer build
  supersedes it.
- [`../../docs/design-system-field-notebook.md`](../../docs/design-system-field-notebook.md)
  — locked Field Notebook v2 tokens, typography, controls, and the walnut
  dark variant.

## Goal

A keyboard-driven tagging UI that a researcher can open in a browser, tag
several hundred images in a session, save progress locally without thinking
about it, and sync to S3 when ready — while preserving the canonical metadata
contract used by the Java app, `sparcd-web`, and the marimo/static explorer.

## Static BYO-S3 security contract

Follow the uploader's static BYO-S3 security model
(`apps/sparcd-uploader/README.md` and `apps/sparcd-uploader/plan.md`). This
tagger is a **static browser app**: no backend service, no trusted server
session, no server-side environment variables at runtime. A security review
must treat the bundle as untrusted client code.

**Decision.** Users bring their own S3-compatible endpoint, credentials,
settings bucket, and collection bucket. Official SPARC'd deployments use the
same model: credentials are scoped by IAM/provider policy and CORS, not by
bucket names compiled into the app.

**Enforceable controls.**

- **IAM / provider policy** limits which buckets, prefixes, and S3 actions
  the supplied credentials can use.
- **Bucket CORS** limits which hosted app origins can make browser S3 calls.
- **`@sparcd/s3-safe`** is the only S3 client boundary. It exposes read
  methods, immutable append-only writers, and one reviewed conditional
  replacement method for canonical Camtrap metadata. No delete or copy API.
- **Sync protocol controls**: dry-run-by-default, `HEAD`/ETag verification,
  pre-write conflict detection, immutable pre-write snapshots, and
  conditional canonical replacement.

**Non-controls.**

- Build-time `VITE_*` bucket allowlists are **not** used for authorization —
  they are not enforceable in a static app and would break BYO-S3 users.
- Client-side bucket discovery is **not** authorization. It only finds
  buckets the supplied credentials and CORS policy already expose.

## Stack

- **Vite + React 18 + TypeScript** — single-page app, fast dev, static bundle
- **Tailwind + Field Notebook bespoke components** — match the uploader
  (`apps/sparcd-uploader`); do not introduce shadcn/ui unless the shared design
  system changes first
- **TanStack Query** — S3 fetch cache and request dedup. **Key every query on a
  `connectionId`**, not on endpoint+access-key alone, and clear the S3 client
  cache on connect/disconnect, so reconnecting with new credentials never serves
  a previous connection's cached data (pattern in
  `apps/sparcd-uploader/src/lib/s3.ts`).
- **TanStack Virtual** — virtualized image lists for large uploads
- **Zustand** — edit/UI state
- **Dexie.js** — IndexedDB wrapper, draft persistence
- **react-hotkeys-hook** — keyboard shortcuts
- **react-zoom-pan-pinch** — full-size image inspection
- **`@sparcd/s3-safe` only for S3** — app code never imports
  `@aws-sdk/client-s3`; presigned image URLs come from
  `SafeS3Client.presignedGet`
- **Vitest** — shared contract tests for Camtrap CSV, upload metadata,
  uploader fixtures, tagger merge output, and wrapper safety behavior
- **`@sparcd/camtrap` CSV parser/writer** — extend the existing writer with the
  readers/merge helpers needed here; use PapaParse internally only if the
  package needs a CSV engine
- **fuse.js** — fuzzy search for species autocomplete

## Shared packages

Lives under `packages/` in this monorepo. Internal-only; no `dist/`,
consumers bundle the source via Vite + pnpm workspace resolution.

### `packages/s3-safe` → `@sparcd/s3-safe`

Exists in the monorepo (`packages/s3-safe/`); the tagger needs one reviewed
extension because Java-compatible tagging must replace canonical metadata. This
is the single, blessed S3 boundary; every tool that touches storage imports it.
The tagger uses the read methods, `writeImmutable` for audit snapshots, and a
new conditional replacement method for canonical `media.csv` /
`observations.csv` / `UploadMeta.json`. It does **not** need
`writeImmutableStream` (the uploader's per-file multipart writer; the tagger
never streams large blobs). Existing surface plus required extension:

1. **Bucket allowlists, not a security boundary in a static app.** The
   constructor is `(cfg, readAllowlist, writeAllowlist = [])` — a separate,
   opt-in **write allowlist that is empty by default** (`BucketNotWritableError`
   is the hard stop). In a BYO-S3 static app the tagger passes broad runtime
   scope (`*`) for both, exactly as the uploader does; IAM/policy + CORS are
   the real gate (see Static BYO-S3 security contract). The allowlist scopes
   *object* operations only.
2. **Read methods**, plus the tagger write surface:
   - `listObjects(bucket, prefix)` → `AsyncIterable<ObjectInfo>`
   - `getObject(bucket, key)` → `Uint8Array`
   - `statObject(bucket, key)` → metadata only
   - `presignedGet(bucket, key, ttlSec)` → URL
   - `listBuckets()` → bucket names; **intentionally not allowlist-gated**
     (it reads no object data) — the discovery primitive the tagger uses to
     find the settings and collection buckets at runtime
   - `writeImmutable(bucket, key, body)` → conditional `PutObject` with
     `IfNoneMatch: "*"`, throwing `PreconditionFailedError` (412) if `key`
     already exists, or `ConditionalPutUnsupportedError` (501) if the backend
     does not enforce the precondition (no silent HEAD-then-PUT fallback)
   - `replaceIfUnchanged(bucket, key, body, { etag, contentType })` →
     conditional `PutObject` with `IfMatch: <etag>` for canonical metadata
     replacement. This is a narrow compatibility exception for
     `media.csv`, `observations.csv`, and `UploadMeta.json`, not a general
     overwrite API.
     It throws a typed conflict if the remote object changed after the draft
     was loaded.
3. **No destructive APIs exposed** — no `delete*` or `copy*`. Direct
   `@aws-sdk/client-s3` imports are forbidden outside `packages/s3-safe/src/`
   by a lint rule added before app code writes to S3.

**`IfNoneMatch: "*"` backend support.** Conditional writes require:
AWS S3 added conditional `PutObject` support in August 2024, then added
bucket-policy enforcement for conditional writes in November 2024. MinIO
and Cloudflare R2 also support conditional PUTs, but the `@sparcd/s3-safe`
README must record the exact backend versions tested for this project.
If the backend responds with `501 NotImplemented` (or returns a 200
success without enforcing the precondition), `writeImmutable` must throw a
distinct `ConditionalPutUnsupported` error and the wrapper must **not**
silently fall back to a `HEAD`-then-`PUT` path — that fallback has a
TOCTOU race the wrapper cannot close, and silently accepting it would
defeat the safety design.

**`IfMatch` backend support.** Canonical compatibility sync additionally
requires conditional replacement with `IfMatch` against the reviewed ETag for
`media.csv`, `observations.csv`, and `UploadMeta.json`. P0/P4 tests must prove
the wrapper sends the header, treats stale ETags as typed conflicts, and does
not fall back to an unconditional PUT. Live browser CORS must expose enough
`HEAD` metadata for this check to work on the target endpoint.

This is stricter than the Java desktop app, which writes with unconditional
`PutObject` and performs no ETag/concurrency check. Tagger `IfMatch` protects
tagger-vs-tagger and tagger-vs-uploader/static-tool writes; it cannot prevent a
concurrent or later Java save from overwriting canonical tagger output.

**P4 design gate.** Do not silently downgrade to Java's last-writer-wins write
behavior. If the target endpoint does not enforce `IfMatch` from browser S3
calls, canonical sync stays disabled for that endpoint and the tool remains
local-only/export-only until the backend/policy is fixed. A deliberately unsafe
Java-compatible overwrite mode would be a separate, operator-approved feature,
not P4 fallback behavior.

Endpoint config is the same shape for all three backends:

```ts
type S3Config = {
  endpoint: string;        // host[:port] or https://host
  region: string;          // "us-east-1" | "auto" | etc.
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean; // true for MinIO; false for AWS/R2
  secure?: boolean;        // when no scheme on endpoint
};
```

Helpers detect the backend from the endpoint and fill defaults:
- `*.r2.cloudflarestorage.com` → `region: "auto"`, `forcePathStyle: false`
- `*.amazonaws.com` → `region: <from URL>`, `forcePathStyle: false`
- anything else → MinIO defaults (`region: "us-east-1"`, `forcePathStyle: true`)

Browser-direct S3 is a hard requirement for this app. P0 must verify the
target endpoint's CORS policy allows the static app origin to call
`ListBucket`, `GetObject`, `HeadObject`, and eventually `PutObject`, and
that signed or presigned image URLs render in `<img>` without canvas access
requirements.

### `packages/camtrap` → `@sparcd/camtrap`

Pure TypeScript. No React, no S3. The package exists in the monorepo
(`packages/camtrap/src/index.ts`); the writer the tagger needs is already there
— the uploader builds against it but always emits an empty `observations.csv`,
leaving the row serializer for the tagger. The tagger extends this package with
readers, merge helpers, and shared fixtures so uploader and tagger tests prove
the same data contract.

- Types: `Deployment`, `Media`, `Observation`, plus a `CamtrapBundle` that
  groups all three for one upload. `Observation` already carries `timestamp`,
  `scientificName`, `count`, and `tags`.
- Reader: **to be added in P0**. Takes raw CSV strings (`deployments.csv`,
  `media.csv`, `observations.csv`) → parsed objects, with the fixed v016
  column-index mapping (no header row) handled in one place. It must
  round-trip rows from Java and `sparcd-web` fixtures and preserve unrelated
  rows when the tagger changes one image.
- Writer: `serializeObservations` emits the v016 **20-column** shape
  byte-for-byte (QUOTE_ALL, LF-terminated). **Column semantics are pinned in
  code (`packages/camtrap/src/index.ts`), not to be re-derived:**
  - col 4 `timestamp` — the corrected ISO timestamp
  - col 8 `scientific_name` + col 9 `count` — the SPARC'd observation
    (species + count only; there is no behaviour field)
  - **col 19 `comments`** — where the bracketed tag markers live (see grammar
    below). There is **no dedicated `tags` column**; everything bracketed
    lands in `comments`.
- Merge helpers: **to be added in P0/P1**. Given canonical media +
  observations and local draft edits, replace the media row and all observation
  rows for the edited media IDs, preserve unrelated rows, filter zero-count
  rows the same way `sparcd-web` does, update media timestamp col 4 when time
  corrections are synced, and update `UploadMeta.json` with Java-compatible
  `imagesWithSpecies` delta semantics.
- Validators: schema checks, lat/lng sanity (latitude and longitude columns are
  easy to transpose — validate ranges), row-count checks, and tag-string parser
  for the `[COMMONNAME:Owl]` format.
- Tag marker grammar: the col-19 `comments` field holds a concatenated list
  of bracketed markers `[PREFIX:value]`. Reserved prefixes for v0 are
  `COMMONNAME` and `REQUESTED_SPECIES`. The parser must preserve and tolerate
  unknown prefixes so future tools can add markers without breaking old
  readers.

### `packages/types` → `@sparcd/types`

Minimal TS types that span more than one package:
- `Collection { bucket, uuid, name, organization }`
- `Species { genus, species, commonName, scientificName }` (plus the tree
  form used by `Settings/species.json`)
- `UserSession { userId, displayName }` for stamping immutable writes

### `packages/auth-ui` → `@sparcd/auth-ui` *(shared from day one)*

One credentials/connection screen, shared by every JS tool (tagger,
uploader, future tools). Two known consumers exist by design, so this is
shared from the start rather than duplicated. The component is
parameterized only by the tool name shown in the chrome ("SPARC'd ·
Tagger" / "· Uploader"). The form is **three fields — endpoint, access
key, secret key** — with secure/region/path-style inferred from the
endpoint (rare overrides behind an "Advanced" disclosure). It produces the
`S3Config` consumed by `@sparcd/s3-safe` and is identical everywhere.
Depends on `@sparcd/types` for the config shape.

## Compatibility test standard

Before implementing tagger S3 writes, add a shared Vitest contract harness that
both `sparcd-uploader` and `sparcd-tagger` consume. This is step 1 because the
data contract is more important than UI polish or storage plumbing.

### Shared fixture layout

Create durable golden fixtures under a shared test-data location, not inside
one app:

- `packages/camtrap/test/fixtures/java-v016/` — canonical `deployments.csv`,
  `media.csv`, `observations.csv`, `UploadMeta.json`, and `species.json`
  shaped like the Java app writes them.
- `packages/camtrap/test/fixtures/sparcd-web-v016/` — the same files shaped
  like current `sparcd-web` Python helpers write/read them. `sparcd-web` is
  newer and may be inconsistent, so Java fixtures are the compatibility
  baseline when behavior differs.
- `packages/camtrap/test/fixtures/uploader-empty-v016/` — a new uploader
  bundle with empty canonical `observations.csv`, matching
  `sparcd-uploader`.
- `packages/camtrap/test/fixtures/tagger-edited-v016/` — expected canonical
  output after common tagger operations: add species, retag species, detag an
  image, multi-species rows, Ghost (`Casper`), timestamp correction in
  `media.csv` col 4 and observation col 4, Java-compatible
  `UploadMeta.json.imagesWithSpecies` delta, mandatory `editComments`, and
  requested-species marker in comments.

Fixtures should be small enough for fast tests but large enough to cover
multiple images, nested paths, multiple deployments when relevant, and one
unrelated row that must survive every merge unchanged.

### Required Vitest coverage

- **Round-trip shape.** Parse fixture CSVs and serialize them without changing
  fixed column counts, row order, quoting policy, or unrelated rows.
- **Uploader contract.** `sparcd-uploader` output parses as valid v016
  Camtrap data and exposes an empty canonical `observations.csv` base for the
  tagger.
- **Tagger merge contract.** Applying draft edits to canonical observations
  and media produces exactly the `tagger-edited-v016` golden output.
- **Retro-compatibility contract.** The edited golden output can be read by
  lightweight Java-compatible and `sparcd-web`-compatible parsers in tests:
  species lives in observation col 8, count in col 9, common name in col 19
  as `[COMMONNAME:<name>]`, and media IDs match the full object keys used by
  `media.csv`.
- **Timestamp display contract.** Corrected capture time is written to
  `media.csv` col 4 because Java and `sparcd-web` decorate displayed image
  timestamps from media rows. Observation col 4 is also updated for edited
  observation rows, but it is not enough by itself.
- **Reader listing contract.** Adding tagger snapshot folders under an upload
  prefix must not add visible images. The current `sparcd-web`
  `get_s3_images` recurses subfolders but only returns `.jpg` and `.mp4`
  objects, so snapshot prefixes must contain only CSV/JSON/manifest files and
  tests/verification must prove the image list is unchanged before and after a
  snapshot subtree exists.
- **UploadMeta contract.** `imagesWithSpecies` follows the Java save delta:
  `prior - detaggedCount + retaggedCount`, where detagged means "was tagged,
  now species-present is empty" and retagged means "was untagged, now
  species-present is non-empty." This deliberately matches Java's maintained
  tally, even if a stored `UploadMeta.json` has drifted from a clean recompute.
  Tests include a drifted-value fixture so the choice is explicit. A future
  admin repair flow may recompute and reconcile drift, but normal tagger sync
  does not.
- **Edit comment contract.** Every successful canonical sync appends an
  `UploadMeta.json.editComments` entry in the Java style:
  `Edited by <user> on <timestamp>`, where `<timestamp>` uses Java's
  `uuuu.MM.dd.HH.mm.ss` format.
- **No accidental data loss.** Retag/detag tests prove the merge only replaces
  rows for edited media IDs and never drops unrelated observations,
  deployments, or media rows.
- **Partial-sync resume contract.** Simulate failures after `media.csv` and
  after `observations.csv`. Retry must verify already-written objects by hash,
  continue from the first pending object, and conflict if any written or pending
  object changed remotely.
- **Snapshot collision contract.** Simulate a 412 on the immutable snapshot
  prefix. The tagger bumps the snapshot stamp by +1s, retries once, writes
  `manifest.json` last, and recovery ignores prefixes without a manifest.
- **Wrapper safety.** Unit tests cover the future `replaceIfUnchanged`
  behavior with mocked S3 responses: success on matching ETag, conflict on
  stale ETag, no fallback overwrite, no delete/copy command.

Root scripts should include `pnpm test` / `turbo run test`, and each package
or app with data-contract code should expose a `test` script. S3 integration
tests stay separate and opt-in; the default Vitest suite must run offline.

## Architecture

### Data flow

```
S3 bucket  ─presigned GET─►  <img>                                   ─┐
                                                                      │ tags
Settings/species.json  ─fetch─►  Fuse index in memory                  │ flow
                                                                      ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  React app                                                    │
        │  ┌─────────┐  ┌──────────────┐  ┌────────────┐                │
        │  │ ImageList│  │ ImageViewer │  │ TagPanel   │                │
        │  └─────────┘  └──────────────┘  └────────────┘                │
        │       ▲              ▲                ▲                       │
        │       └──────┬───────┴────────────────┘                       │
        │              ▼                                                │
        │       Zustand store ──auto-save──► Dexie (IndexedDB)         │
        └──────────────────────────────────────┬───────────────────────┘
                                               │ manual "Sync"
                                               ▼
                         immutable snapshot + conditional canonical replace
                                               │
                                               ├─ replaceIfUnchanged() → <uploadPrefix>/media.csv
                                               ├─ replaceIfUnchanged() → <uploadPrefix>/observations.csv
                                               └─ replaceIfUnchanged() → <uploadPrefix>/UploadMeta.json
```

### Layout

Three-pane CSS grid:

- **Overview** — the primary working surface, with two view modes
  (file-explorer style) switched by a segmented control: **grid** of
  thumbnail cards, and a denser **list** whose rows each carry a tiny
  thumbnail + metadata. Both group by burst/sequence (visual bands) and
  share one selection model: single, range (Shift), additive (Cmd/Ctrl),
  whole-burst. This is where most of an upload gets cleared — bulk-tagging
  a selection in one action.
- **Focus** — `ImageViewer`, the single-image detail view drilled into
  from a thumbnail: pan/zoom, image adjustments for hard night frames,
  prev/next, timestamp + deployment overlay. For careful IDs, not bulk.
- **Right** — `TagPanel`. Species selector + count. (A SPARC'd observation
  is species + count only — there is no behavior field; see the data note
  below.) Submit applies to **all selected images at once**.
- **Top bar** — collection picker, sync status (`local-only` /
  `unsynced edits` / `synced @ <time>` / `conflict`), keyboard cheatsheet
  button. **Collection discovery reuses the uploader's runtime model**
  (`apps/sparcd-uploader/src/lib/s3.ts`): list visible buckets, keep
  `sparcd-<uuid>` candidates, read `Collections/<uuid>/collection.json`, and key
  selection as `bucket::uuid`. If collection discovery later becomes
  bucket-name-agnostic, update uploader and tagger together; do not let the
  tagger invent a divergent collection model.

### Performance & interaction

Snappiness and keyboard latency are first-class requirements — the tool
lives or dies on them. These are implementation requirements, separate from
visual design:

- **Virtualized thumbnail grid** (TanStack Virtual) — only mount visible
  cells; a 5,000-image upload must scroll at 60fps.
- **Thumbnail strategy** — request small presigned-URL thumbnails, lazy +
  progressive load, `loading="lazy"` / `IntersectionObserver`, decode off
  the main thread (`createImageBitmap`), and an LRU cache so revisiting a
  burst is instant. Camera-trap originals are 1–5MB; never load originals
  into the grid.
- **Keybindings** — global handler with no per-render re-binding; actions
  dispatch synchronously and update local (Zustand) state optimistically,
  so navigation/species keys never wait on I/O. Dexie writes are debounced and
  off the hot path.
- **Selection at scale** — selection state is index ranges, not per-cell
  React state, so selecting a 2,000-image burst doesn't re-render 2,000
  components.
- **CORS error translation** — reuse the uploader's mapping: 404 → "not found",
  403 → "access denied", and a status-less browser fetch failure → "endpoint
  unreachable or the bucket CORS policy needs to allow GET/HEAD from this
  origin." A **live in-browser CORS preflight against the endpoint is still
  unconfirmed** and this origin may need adding to the bucket CORS policy.

### Login screen

**Three fields only: endpoint, access key, secret key** (the marimo Python
explorer's pattern). Everything else is *inferred*, not asked:

- **Secure (HTTPS)** from the endpoint scheme (`https://` → secure; default
  secure when no scheme).
- **Region + path-style** auto-detected from the endpoint host by
  `@sparcd/s3-safe` (R2 / AWS / MinIO — see the detection rules above). No
  preset dropdown, region field, or path-style toggle on the main screen.
- Rare manual region / path-style overrides live behind a collapsed
  **"Advanced"** disclosure, hidden by default.
- Per-tool **identity** and **dry-run default** live in **Settings**, not
  the login gate.

Values prefill from `.env` during local development only. In deployable
static builds, `import.meta.env` may prefill non-secret convenience values
such as endpoint, region, and path defaults, but must never embed real access
keys or secret keys, and **never a bucket allowlist as an authorization
boundary** (buckets are discovered at runtime — see the security contract).
Users enter S3 credentials at runtime. The Java and sparcd-web apps use a
different model (server-issued token); this tool does not share auth UI with
them.

### Persistence — local

- **Dexie schema** v1:
  - `drafts` table:
    `{ id (bucket+uploadPrefix+mediaPath), bucket, uploadPrefix, mediaPath,
    baseMediaETag, baseMediaHash, baseObservationsETag,
    baseObservationsHash, baseUploadMetaETag, baseUploadMetaHash,
    auditSnapshotKey, label, count, freeTags, requestedSpecies, questionable,
    timeOverride, lastEdited, dirty }`
    (`timeOverride` = optional corrected timestamp for this one image, on
    top of the upload offset; null when unset.)
    `label` holds the applied species **or** a non-animal label like
    **Ghost** — Ghost is just another label, not a separate `blank` flag. A
    SPARC'd observation is **species + count only** — there is no `behavior`
    field. The value/encoding (how Ghost and species land in
    `observations.csv`) is **already pinned** by the existing
    `serializeObservations`: species → col 8 `scientific_name` + col 9
    `count`; bracketed markers → col 19 `comments`. Ghost is encoded as a
    label through the same path, not a separate flag.
  - `uploads` table:
    `{ id (bucket+uploadPrefix), bucket, uploadPrefix, loadedAt,
    mediaETag, mediaHash, observationsETag, observationsHash, uploadMetaETag,
    uploadMetaHash, timeOffset }`
    (`timeOffset` = signed Δ y/mo/d/h/m/s applied to every image in the
    upload; null when unset.)
  - `sessions` table:
    `{ sessionId, userId, startedAt, finishedAt, syncedAt, syncedKey,
    syncedCsvHash }`
- **Grounding rule.** The uploader **always writes an empty canonical
  `observations.csv`** on initial upload (its open question resolved), so a
  stable base file is guaranteed — no absent-file case to handle. Every draft
  is grounded on the canonical upload-level `media.csv`, `observations.csv`,
  and `UploadMeta.json` loaded at session start. Sync-time conflict detection
  compares current remote ETag/hash values for all three files against the
  stored base values; mismatch triggers the conflict view before any canonical
  write.
- **`requestedSpecies` field.** When a tagger needs a species not in
  `Settings/species.json`, the combobox lets them tag with a free-text
  `requestedSpecies` string plus the existing `freeTags`. The sync export
  records the request as a `[REQUESTED_SPECIES:<value>]` marker in the col-19
  `comments` field (alongside `[COMMONNAME:…]`), so the output keeps the
  `observations.csv` row/column shape while still giving downstream admins a
  machine-readable request. The tagger never edits the species hierarchy itself
  (see Out of scope).
- **Schema versioning.** Future schema changes use Dexie's versioning API
  (`db.version(N).stores({...}).upgrade(...)`). No ad-hoc store mutations
  outside that ladder; every bump ships with an `upgrade` callback that
  carries v(N-1) drafts forward, never destructively.
- Auto-save on every keystroke (debounced 200 ms). Recovery on next open
  surfaces any `dirty` drafts.
- Per-upload "Discard local changes" button — affects only that upload.

### Persistence — S3 sync

- "Sync" button is the only path that writes to S3.
- Pre-write:
  - `HEAD` + load canonical `<uploadPrefix>/media.csv`,
    `<uploadPrefix>/observations.csv`, and `<uploadPrefix>/UploadMeta.json`.
  - If any ETag/hash differs from the draft base, enter the conflict view:
    reload remote, show local-vs-remote media/observation/meta diffs, and
    require the user to merge or discard local edits before retrying.
  - Diff local drafts against canonical media and observations. Show a
    confirmation dialog: timestamp corrections, N additions, M modifications,
    D removals. A removal means "remove this species row from this media item"
    and is required for re-tagging compatibility; it is not an object delete.
  - Write immutable audit snapshots of the pre-change canonical files under
    `<uploadPrefix>/.sparcd-tagger-snapshots/<userId>/<ISO>/` using
    `writeImmutable`. These snapshots are for recovery only. Snapshot prefixes
    contain only non-image files (`media.csv`, `observations.csv`,
    `UploadMeta.json`, `manifest.json`) so recursive image readers do not
    surface them.
  - Snapshot `manifest.json` is written last. If `writeImmutable` returns 412
    for a snapshot key, bump the snapshot stamp by +1s, rebuild the snapshot
    prefix, and retry once, matching the uploader's re-stamp pattern. Recovery
    only lists snapshot prefixes with a complete manifest; partial prefixes are
    ignored unless an operator inspects them manually.
- Write:
  - `replaceIfUnchanged(bucket, "<uploadPrefix>/media.csv", serialized, { etag: baseMediaETag })`
  - `replaceIfUnchanged(bucket, "<uploadPrefix>/observations.csv", serialized, { etag: baseObservationsETag })`
  - `replaceIfUnchanged(bucket, "<uploadPrefix>/UploadMeta.json", serialized, { etag: baseUploadMetaETag })`
  - `UploadMeta.json.imagesWithSpecies` follows Java's running delta:
    `prior - detaggedCount + retaggedCount`. Detagged/retagged are computed
    from the same before/after species-present state used for the edited
    media rows, not from a full-bundle recompute.
  - `UploadMeta.json.editComments` is appended on every successful sync with
    the Java-style `Edited by <user> on <timestamp>` entry, using
    `uuuu.MM.dd.HH.mm.ss` for the timestamp.
  - S3 has no atomic three-object transaction. The write order is `media.csv`
    first, `observations.csv` second, `UploadMeta.json` third: if the final
    metadata write fails, existing tools can still read the new timestamp/tags,
    but the upload tile count or edit comment may be stale until the tagger
    retries. If the observations write fails after `media.csv`, readers may
    show corrected capture time before species changes. The recovery view must
    detect and repair either partial-sync state.
  - Persist a per-object sync journal before the first canonical write:
    object key, base ETag, intended SHA-256, status (`pending` / `written`),
    and new ETag when available. On failure after any canonical PUT, retry is a
    resume, not a blind whole-sync retry:
    1. Re-HEAD/load the three canonical objects.
    2. For objects marked `written`, require the remote hash to equal the
       intended hash; otherwise enter conflict repair because another writer
       changed a partially synced object.
    3. For remaining `pending` objects, require the remote ETag/hash to still
       match the stored base before writing with that current ETag.
    4. Continue from the first pending object forward (`media.csv` →
       `observations.csv` → `UploadMeta.json`), recording each new ETag.
    5. When all three objects are verified/written, clear the journal and mark
       the draft synced.
  - On a conditional conflict, do not retry blind. Reload, show conflict UI,
    and require an explicit merge.
  - Records `syncedAt`, new ETags, and hashes in Dexie.
- Recovery view: lists local snapshots and remote
  `.sparcd-tagger-snapshots/<userId>/<ISO>/` versions, lets the user inspect
  or restore one by running the same conditional canonical replacement flow.

The canonical files are no longer read-only in this tool. Updating them is the
point of S3 sync because current Java, `sparcd-web`, and marimo/static preview
tools read those files and ignore append-only sidecars.

## Safety design

"Absolutely no accidental writes" is a load-bearing requirement for this tool.
Four layers, each redundant:

1. **IAM policy** — separate access key whose policy permits only
   `s3:ListBucket`, `s3:GetObject`, and `s3:PutObject` on
   `arn:aws:s3:::sparcd-test-*` (or the explicit test-bucket ARN list), with
   writes scoped to canonical compatibility files and audit snapshots:
   `Collections/*/Uploads/*/media.csv`,
   `Collections/*/Uploads/*/observations.csv`,
   `Collections/*/Uploads/*/UploadMeta.json`, and
   `Collections/*/Uploads/*/.sparcd-tagger-snapshots/*` where the backend
   supports object-prefix conditions.
   **No `s3:DeleteObject`.** Belt + suspenders below in case the policy
   is ever misconfigured.
2. **`@sparcd/s3-safe` wrapper** — the only S3 client allowed in app code.
   No destructive methods exposed. Lint rule blocks direct
   `@aws-sdk/client-s3` imports anywhere except `packages/s3-safe/src/`.
3. **Runtime permissions, not build-time bucket gates** — this is a static
   BYO-S3 app, so bucket names are never compiled into the bundle as a security
   boundary: a static bundle can't enforce that, and a hardcoded allowlist
   breaks BYO-S3 users. The connected credentials' IAM policy and bucket CORS
   decide what the browser can read or write. The app discovers the
   settings/collection buckets by probing for marker objects, keeps dry-run on
   by default, and uses only the reviewed wrapper APIs.
4. **Conditional canonical replacement** — every sync snapshots the old
   canonical files immutably, then replaces only `media.csv`,
   `observations.csv`, and `UploadMeta.json` with `IfMatch` against the ETags
   the user reviewed. A stale ETag is a conflict, never an automatic overwrite.

Plus a **dry-run toggle** on the sync action, on by default for the first
session. Until the user explicitly turns dry-run off, sync logs what it
would do and writes nothing.

## Time correction

Camera clocks drift / are misconfigured (DST, timezone), and corrected
timestamps drive downstream activity analysis. Two levels, mirroring the
SPARC'd Java app's `TimeShiftController` (signed offsets in
year/month/day/hour/minute/second with a live preview) and per-image
`setDateTaken`:

- **Upload-level offset** — a signed Δ (y/mo/d/h/m/s) applied to every image
  in the upload. Set from the Tag workspace / upload-scoped Settings, with a
  live "original → corrected" preview and a persistent active-offset
  indicator.
- **Per-image override** — edit one image's timestamp in the Focus view, on
  top of the upload offset.

**Non-destructive.** Originals (EXIF / canonical CSV timestamps) are never
rewritten locally outside the reviewed sync path. Corrections are stored locally
(`uploads.timeOffset`, `drafts.timeOverride`), applied on display, and emitted
as the corrected timestamp in the canonical synced output. The corrected
display/capture timestamp must be written to `media.csv` col 4
(`Media.timestamp`), because Java and `sparcd-web` decorate image capture time
from media rows. Edited observation rows also carry the corrected timestamp in
`observations.csv` col 4 (`Observation.timestamp`), per the existing
`serializeObservations`, but writing observations alone is not sufficient.

## Sequence/burst grouping

Default heuristic: same deployment + image timestamps within `60s` of each
other → same burst. Threshold configurable per-session (slider, 5s–600s).

Bursts render as visual bands in `ImageList`. The "Apply to whole burst"
button is one keystroke.

## Species / label autocomplete

- Load `Settings/species.json` once at session start. **It lives in the
  settings bucket, not the per-collection bucket** — `Settings/locations.json`
  resolves the same way (prefer `sparcd-settings-*`, fall back to legacy
  `sparcd`), discovered by probing visible buckets for the marker. P0 reuses
  that discovery (`apps/sparcd-uploader/src/lib/s3.ts`) for `species.json`
  rather than assuming the collection bucket.
- P0 validates the exact object path and JSON shape against the live bucket.
  Watch for the same **id-is-not-unique** contract `locations.json` has (ids
  repeat with different data; upstream keys by a composite) — confirm whether
  species keys are unique before keying anything on them.
- Build a Fuse index over `commonName` + `scientificName` + `genus`.
- **Persistent, scrollable, browsable list — not only a type-to-filter
  popover.** Volunteers don't know the list cold; scanning to recognize a
  species is core workflow. Each row shows an **example thumbnail** of the
  animal + common name + scientific name + its assigned key (if any). Filter
  box at top; hierarchy (Genus → Species) drillable.
- **Per-species, user-assignable, persistent keybindings — not rotating
  numeric keys.** Each species can carry a stable key the user assigns once
  (shown as a kbd badge on its row, with an "assign key" affordance);
  pressing it tags that species; bindings are suppressed while the filter
  box is focused. This matches the SPARC'd Java app, where each species has
  a persisted `keyBinding` in `species.json` — so it is data-compatible.
  Rotating 1–9 "recent" keys are **not** used: they can't build muscle
  memory on a large list.
- "Recent / frequent this session" affects only **list ordering** (floats
  local fauna to the top), never key assignment.
- Example-image source is a build decision (per-species reference image or a
  representative already-tagged frame), sourced from the upstream SPARC'd
  species data / sparcd-web / Java app — not invented here.
- The vocabulary includes non-animal labels — notably **Ghost** (empty /
  false-trigger frame, shown as a text chip not a photo) — applied exactly
  like a species through the same list + bulk-tag path. Ghost is a core
  manual label, not a separate mechanism, and there is no automated ghost
  detection in this tool. Compatibility default: because Java keys detag/retag
  on whether `getSpeciesPresent().isEmpty()`, Ghost/Casper counts as
  species-present when encoded as a species/label row. That means Ghost-tagged
  images count toward `UploadMeta.json.imagesWithSpecies` and can be
  "retagged" from Java's perspective. Confirm before P0 whether this semantic
  should remain; changing it would intentionally diverge from Java behavior.

## Keyboard shortcuts (initial set)

| Key | Action |
|---|---|
| `Arrow Down` / `Arrow Up` | Next / previous image |
| `PgDn` / `PgUp` | Next / previous burst |
| `Space` | Open species autocomplete |
| `Enter` | Confirm selection |
| _assigned key_ | Apply the species/label bound to that key (user-assignable, persistent per species; suppressed while the filter box is focused) |
| `G` | Default binding for **Ghost** (empty / false-trigger frame) — a normal pre-bound label, common enough to ship bound |
| `Shift+Space` | Mark as "questionable" |
| `Cmd/Ctrl+A` | Select current burst |
| `Cmd/Ctrl+S` | Save draft (auto-saves anyway; manual confirm) |
| `?` | Toggle cheatsheet modal |

## Phased delivery

| Phase | Scope | S3 writes |
|---|---|---|
| **P0** | **Shared Vitest contract harness first**: root/package `test` scripts, Java-baseline and `sparcd-web` fixture data, uploader-empty fixture, tagger-edited golden fixture; extend `@sparcd/camtrap` with v016 readers/merge helpers; prove uploader output parses and tagger merge output matches golden files; scaffold app, reuse the four existing shared packages (`s3-safe`, `camtrap`, `types`, `auth-ui`); shared Connection screen; existing uploader collection discovery (`sparcd-<uuid>` candidates); image viewer reads from a discovered collection; verify browser CORS for list/get/head; validate `Settings/species.json` path/shape | None |
| **P1** | Single-image tag editing; Dexie drafts; arrow-key nav; species autocomplete | None |
| **P2** | Sequence/burst grouping; full keyboard set; cheatsheet modal | None |
| **P3** | Batch tagging (multi-select); recovery view (local-only at this stage) | None |
| **P4** | Compatibility sync: immutable pre-write snapshots plus conditional canonical replacement of `<uploadPrefix>/media.csv`, `<uploadPrefix>/observations.csv`, and `<uploadPrefix>/UploadMeta.json`; explicit per-object resume journal for partial three-file writes; snapshot-prefix +1s re-stamp on 412; verified that `.sparcd-tagger-snapshots/` does not change the reader image list; only after manual review of `replaceIfUnchanged`, mocked wrapper tests, fixture-backed merge tests, and endpoint-specific CORS/PUT preflight | First writes, dry-run by default |
| **P5** | Snapshot/version recovery: load prior snapshots into local, restore through the same conditional canonical replacement flow | Same as P4 only on restore |
| **P6** | Internal navigation sections beyond the tagging core: Browse, History (surfaces the P5 recovery capability), Settings | Reads only |

P0–P3 are fully usable as a local-only tagger. The S3 write path doesn't
exist in the build until P4, which means the safety wrapper can be
reviewed in isolation before any real bucket is at risk.

### P0 — implementation report (done)

Status: **complete, local-only/read-only.** `pnpm test` (39 tests) and
`pnpm check` (all 4 workspaces) pass; `pnpm --filter sparcd-tagger build`
produces a static bundle. Nothing in this build can write to S3 — the wrapper's
write methods are simply not called, and the tagger constructs `SafeS3Client`
with a read-only scope.

**Data contract — `@sparcd/camtrap` (the priority, done first).** Extended
`packages/camtrap/src/index.ts` with everything the merge tests need; the v016
writers were left untouched as the byte-shape source of truth. Added:
- `parseCsvRows` / `serializeCsvRows` — a tokenizer + writer-policy serializer
  that round-trips writer output byte-for-byte and tolerates the looser live
  shapes (bare fields, embedded commas/newlines, stray CR).
- Typed readers `parseDeployments` / `parseMedia` / `parseObservations` and the
  fixed column-index maps (`MEDIA_COL`, `OBS_COL`, `DEPLOY_COL`).
- Tag-marker grammar: `parseTagMarkers` / `serializeTagMarkers` /
  `buildObservationComments` / `commonNameFromComments` /
  `requestedSpeciesFromComments`. Unknown prefixes are preserved.
- Merge: `mergeMedia` (rewrites only edited media col 4),
  `mergeObservations` (replaces all rows for an edited media id, preserves
  unrelated rows **and unmodelled columns** verbatim, drops zero-count rows like
  sparcd-web), `computeSpeciesDelta` + `applyUploadMetaEdit` (Java
  `prior − detagged + retagged`, mandatory `Edited by … on …` comment,
  key order preserved). **Merge operates on raw rows, not the typed view**, so a
  sync never silently drops a column the tagger doesn't model.
- Time correction: `shiftTimestamp`, `correctedTimestamp` (per-image override
  beats upload offset), `TimeOffset`/`ZERO_OFFSET`, `javaEditStamp`.
- Validators: `validateCoordinates` (range + transposition heuristic),
  `validateColumnCount`.

**Shared fixtures + Vitest harness.** `packages/camtrap/test/fixtures/` holds
`java-v016`, `sparcd-web-v016`, `uploader-empty-v016`, and `tagger-edited-v016`,
materialized by a committed, self-documenting `_generate.mjs` whose **expected
tagger output is hand-built, independent of the merge code it validates** (so
the golden comparison is a real check, not a tautology). Fixtures include a
populated unrelated survivor row (IMG004, rich behaviour/taxon_id/etc.), a
multi-species image, a requested-species marker, a Ghost/Casper detag, a
per-image time correction, and a drifted `UploadMeta.drifted.json`. Tests
(`csv`, `readers`, `merge`, `contracts`) cover round-trip, uploader-empty base,
tagger→golden byte equality, retro-compat field positions, zero-count filter,
no-data-loss, UploadMeta drift, edit-comment format, and time math. Root `test`
script + per-package `test` wired through turbo; default suite runs offline.

**App scaffold (`apps/sparcd-tagger/`).** Vite + React 18 + TS, reusing the four
shared packages and the uploader's proven config (Tailwind/Field Notebook
tokens, `base: '/sparcd-exploration/tagger/'`). Shared `@sparcd/auth-ui`
Connection gate (three fields). `src/lib/s3.ts` reuses the uploader's runtime
collection model verbatim (`sparcd-<uuid>` candidates → `collection.json`
marker, `bucket::uuid` keying, `connectionId`-scoped client cache cleared on
connect/disconnect) and adds `listUploads`, `listUploadImages` (sparcd-web
`get_s3_images` parity: recurse, return only `.jpg`/`.mp4`), and
`presignImage`. Browse section drills collection → upload → presigned image
grid (the "image viewer reads from a discovered collection" gate). Chrome with
Browse/Tag/History/Settings tabs + a `StatePill` wired for all sync states (live
value `local-only`). Settings holds identity + dry-run default + burst
threshold. CORS error translation reuses the uploader's 404/403/status-less
mapping.

**`Settings/species.json` — path + shape confirmed.** Verified against the
upstream writer (`model/species/Species.java` + `resources/species.json`, via
`gh api`): a **flat** JSON array of
`{ name, scientificName, speciesIconURL, keyBinding }` — `name` is the common
name, `keyBinding` is a Java KeyCode string (e.g. `"D"`, `"DIGIT1"`) or null.
**No genus/species tree and no `id` field**, so `@sparcd/types.Species`
(genus/species/commonName) does not match the on-disk file; `src/lib/species.ts`
defines the real shape and keys on `scientificName`, collapsing duplicate
scientific names (id-is-not-unique caution carried over from `locations.json`).
The Fuse index over name + scientificName lands in P1 when the species panel is
built; the loader/parser exist now and surface a count in Browse.

**Open question #4 (Ghost/Casper) — resolved as the compatibility default and
encoded in tests.** Ghost is encoded as a species/label row (`Casper`, count ≥1)
and therefore counts as species-present, so it participates in detag/retag
exactly like Java. The `tagger-edited-v016` golden exercises both a Ghost
**detag** (IMG003, −1) and a Ghost **add** (IMG005, +1).

**Not closeable offline — needs the next agent / live credentials:**
- **Browser CORS preflight + `species.json` presence.** The read code paths and
  error translation are built, but no live `ListBucket`/`GetObject`/`HeadObject`
  preflight has been run against the target endpoint (no credentials in this
  workspace). Drop an `apps/sparcd-tagger/.env` with
  `VITE_SPARCD_S3_ENDPOINT` + a read-only key and run `pnpm --filter
  sparcd-tagger dev` to confirm the origin is allowed and that
  `Settings/species.json` exists in the live settings bucket. The `.jpg`/`.mp4`
  `<img>` render-without-canvas assumption is encoded in `Thumb.tsx` and should
  be eyeballed live.
- Open questions #1–#3 (snapshot/edit-comment identity persistence, first
  write-allowed credentials, `IfMatch`/`IfNoneMatch` backend enforcement) remain
  **P4 gates** and are untouched here by design — P0 writes nothing.

**For the P1 agent:** the merge/draft data model is ready
(`MediaEdit`/`ObservationInput` in `@sparcd/camtrap`). P1 adds the Dexie `drafts`
schema, the Tag workspace (currently a `Placeholder`), J/K nav, and the
persistent species panel + Fuse index over the already-loaded `useSpecies`
data. Keep all S3 read access behind `src/lib/s3.ts`; do not import
`@aws-sdk/client-s3` in app code.

### P1 — implementation report (done)

Status: **complete, local-only.** `pnpm check` (4 workspaces), `pnpm test`
(camtrap 39 + uploader 36 + **tagger 9 new**), and `pnpm --filter sparcd-tagger
build` all pass. Still nothing writes to S3 — `src/lib/s3.ts` constructs
`SafeS3Client` with read scope only and no write method is called. New dep:
`dexie@^4.0.8` (already in the lockfile from the uploader). `react-hotkeys-hook`
and `react-zoom-pan-pinch` from the stack list were **not** added — see notes.

**Dexie drafts (`src/lib/db.ts`).** v1 schema exactly as the plan specifies:
`drafts` (keyed `${bucket}::${uploadPrefix}::${mediaPath}`, indexed
`[bucket+uploadPrefix]`), `uploads` (`${bucket}::${uploadPrefix}`, holds
`timeOffset` + the P4 grounding ETags/hashes as optional fields), and
`sessions`. The `base*ETag/Hash` / `auditSnapshotKey` / `timeOverride` /
`timeOffset` fields all live in the v1 shape now so P4 adds **no schema bump**;
P1 leaves them undefined and writes only the edit fields. `dirty` is a boolean,
so it is **not** an IndexedDB index — `listDirtyDrafts` filters in JS (the
recovery scan P3 will use). Helpers: `loadDraftsForUpload`, `listDirtyDrafts`,
`discardUploadDrafts`.

**Draft store (`src/lib/drafts.ts`).** A Zustand store is the hot path; Dexie is
a debounced (200 ms, per-record) write-through mirror, off the keystroke path
per the perf contract. Mutations replace the top-level `drafts` object but
preserve unchanged record references, so a per-row `s.drafts[path]` selector
re-renders only the edited row — tagging one image never re-renders the strip.
`applyTag` / `detag` / `toggleQuestionable` / `loadUpload` / `discardUpload`.
**Single label per image in v1** (the plan's draft schema is single
`label`+`count`); multi-species rows are deferred — noted below. Ghost is the
built-in `{ label: 'Casper', commonName: 'Ghost' }` constant, encoded as a
species row so it counts as species-present (the P0 compatibility decision).

**Canonical base (`src/lib/s3.ts` + `src/lib/workspace.ts`).** Added
`loadCanonicalBundle` (reads `<prefix>media.csv` + `observations.csv`) and
`buildTagImages`, which joins them into per-image base state: `media.csv` is the
authoritative image list/order and the source of `deploymentId` + capture time
(col 4), and existing `observations.csv` rows seed each image's already-tagged
label/common-name/count (so prior Java/sparcd-web/tagger work shows on reopen).
Surfaced via `useTagImages` in `queries.ts`. The Tag workspace grounds on
`media.csv` directly rather than `listUploadImages`, because the readers do too.

**Species panel + keybindings (`src/components/SpeciesPanel.tsx`,
`src/lib/keys.ts`).** A persistent, scrollable, browsable list (not just a
type-to-filter popover): each row shows the `speciesIconURL` thumbnail, common +
scientific name, a kbd badge, and an assign/rebind/clear affordance. Fuse index
over `commonName` + `scientificName` (no genus in the on-disk shape). A built-in
Ghost row (text chip) and a "Request '…'" row that emits a free-text
`[REQUESTED_SPECIES:…]`. Per-species keys are **user-assignable and persistent**
(localStorage via Zustand `persist`), seeded from the desktop app's data-compatible
`species.json` `keyBinding` (Java KeyCode → `KeyboardEvent.key` via
`normalizeJavaKeyCode`), with **local overrides winning** and a key uniquely
owned by one species. Recent-this-session affects list **ordering only**, never
key assignment — exactly as the plan requires.

**Tag workspace (`src/sections/Tag.tsx`).** Three-pane grid: image strip (tiny
thumb + tag status + unsaved dot per row) · focus view (full presigned image +
filename/timestamp/deployment + applied-tag chip + Detag) · species panel.
Keyboard: a **single global `keydown` handler attached once**, reading the
latest state through a ref so it never re-binds per render (perf contract). Wired
`Arrow Down`/`Arrow Up` next/prev, `PgDn`/`PgUp` bursts, `Space` focus filter,
`Enter` apply top filter match + blur, `Shift+Space` questionable, `G` Ghost,
and **assigned species keys**; all
species/label keys are suppressed while the filter box is focused, and an
"assign key" capture mode swallows the next key. The Chrome sync pill now shows
`unsynced edits` when dirty drafts exist (still local-only; P4 owns real sync).

**Tests (`apps/sparcd-tagger/test/`, new vitest harness + `test` script wired
into turbo).** `workspace.test.ts` proves the media↔observations join + base
seeding (using raw col-4 media rows, since the uploader's `serializeMedia`
intentionally blanks col 4). `keys.test.ts` proves Java KeyCode normalization
and override-wins resolution. Data-shape contracts remain in `@sparcd/camtrap`.

**Deliberate deviations / deferrals (for the P2+ agent):**
- **`react-hotkeys-hook` not used.** The plan's perf section mandates a "global
  handler with no per-render re-binding"; a single ref-backed `window` listener
  satisfies that better than per-component hooks. The dep was dropped, not
  forgotten.
- **No virtualization yet.** The strip and species list render plainly. Fine for
  the small Educational Test collection; `@tanstack/react-virtual` for the
  thumbnail grid is a P2 perf task (5,000-image @60fps target).
- **Single label per image.** Matches the v1 Dexie schema. Multi-species rows
  (a fixture case for P4 merge) need either a schema change to an
  `observations[]` array or a separate model; `MediaEdit.observations` in
  `@sparcd/camtrap` already accepts an array, so the merge side is ready.
- **Time correction UI not built.** `drafts.timeOverride` + `uploads.timeOffset`
  fields exist and persist, but the upload-offset/per-image-override editors
  (the "Time correction" section) are unbuilt — a natural P2 add alongside
  bursts, or its own pass.
- **`Cmd/Ctrl+S`, `?` cheatsheet, `Shift+J/K` burst nav, `Cmd/Ctrl+A`** are P2
  (full keyboard set + cheatsheet modal); only the P1 subset is wired.
- Live CORS/`species.json` presence is **still unverified** (carried from P0 —
  no credentials in this workspace). Drop an `apps/sparcd-tagger/.env` and run
  `pnpm --filter sparcd-tagger dev` to confirm the read path against the live
  endpoint, then eyeball the Tag workspace end-to-end.

### P2 — implementation report (done)

Status: **complete, local-only.** `pnpm --filter sparcd-tagger check` (tsc),
`pnpm test` (camtrap 39 + uploader 36 + **tagger 15**, the 6 new being burst
grouping), and `pnpm --filter sparcd-tagger build` all pass. Still nothing
writes to S3 — the draft store only mutates Dexie/Zustand. No new deps
(`react-hotkeys-hook` stays unused — see P1's note; the single ref-backed
`window` handler now carries the full keyboard set).

**Burst grouping (`src/lib/bursts.ts`, `test/bursts.test.ts`).** `groupBursts`
walks `media.csv` order (the authoritative order the workspace already grounds
on) and starts a new burst when the deployment changes or the gap to the
previous image exceeds the threshold. It groups on the **base capture
timestamp**: a uniform upload offset shifts every image equally so it never
changes a gap, and per-image overrides are rare — when the time-correction UI
lands it can pass corrected timestamps without changing the contract. Gaps use
`Math.abs`, so out-of-order rows still group when close; a missing timestamp
always breaks the run (an unknown gap is "not the same burst"). Returns
`{ bursts, burstOf }` (burst list + index→burstId map). Threshold is the
existing per-session `burstThresholdSec` (5–600s slider in Settings).

**Visual bands + selection (`src/sections/Tag.tsx`).** The image strip now
renders one sticky **burst band** header per burst (`Burst N · M img ·
HH:MM:SS–HH:MM:SS`) above its rows, each with a "select" affordance. A
`Set<number>` of image indices is the selection; empty means "operate on the
focused image", non-empty means operations hit the whole selection. Clicking a
row sets focus and clears selection (single-select); the general
range/additive multi-select and the grid/list Overview view modes are **P3**.
Selection highlight currently re-renders the strip on selection change — fine
for the Educational Test collection; the plan's index-range optimization to
avoid re-rendering thousands of cells is a **P3 perf task** alongside
virtualization (still not added).

**Full keyboard set (the P2 mandate).** Added to the global handler on top of
P1's `J/K`/arrows/`Space`/`Enter`/`X`/`G`/assigned-keys: **`Shift+J`/`Shift+K`**
jump focus to the next/prev burst (clearing selection); **`Cmd/Ctrl+A`** selects
the burst containing focus (the "apply to whole burst is one keystroke" path —
then a species key applies to all); **`Cmd/Ctrl+S`** flushes pending debounced
Dexie writes immediately and flashes a transient "saved ✓"; **`Esc`** clears the
selection (or blurs the filter while typing); **`?`** toggles the cheatsheet.
Plain `J`/`K` also clear selection so single-image nav is unambiguous. Species
keys, `G`, and `X` now operate over the selection when one exists. `X` anchors
its new questionable value on the focused image so a mixed selection resolves
predictably.

**Batch draft mutations (`src/lib/drafts.ts`).** `applyTagMany` / `detagMany` /
`setQuestionableMany` apply one patch to many targets in a **single** Zustand
`set` (one re-render of changed rows, not N sequential mutations), each
scheduling its own debounced Dexie write; the single-image methods now delegate
to the shared `mutateMany`/`tagPatch`. `flushSaves` clears the pending timers
and `bulkPut`s the current records (the manual `Cmd/Ctrl+S` confirm). New
`TagTarget` type = `{ mediaPath, deploymentId }`.

**Cheatsheet modal (`src/components/Cheatsheet.tsx`).** A passive reference card
grouped Navigate / Tag / Select & save, mirroring the plan's shortcut table.
Toggled by `?`, dismissed by `?` again, `Esc`, the × button, or a backdrop
click; while open the global handler swallows every other key. The top-bar
cheatsheet button described in the layout note is **not** added — the modal is
Tag-scoped and Chrome is shared chrome; `?` is the entry point for now.

**Deliberate deferrals (for the P3+ agent):**
- **Multi-select beyond whole-burst.** Shift-range and Cmd/Ctrl-click additive
  selection across the grid, and the segmented grid/list Overview view modes,
  are **P3**. The selection model (`Set<number>` + batch store methods) is the
  seam P3 extends; whole-burst is the only selection gesture wired in P2.
- **Index-range selection + virtualization.** Selection is a plain index set
  and the strip renders every row; the perf contract's index-range selection
  and `@tanstack/react-virtual` grid are P3 (5,000-image @60fps target).
- **Time-correction UI still unbuilt** (carried from P1). Burst grouping uses
  base timestamps; it will transparently pick up corrected times once the
  offset/override editors exist and feed `groupBursts`.
- Live CORS / `species.json` presence remains **unverified** (no credentials in
  this workspace) — same `.env` + `pnpm --filter sparcd-tagger dev` check P0/P1
  flagged.

**For the P3 agent:** burst bands and the batch store methods are the
foundation for full multi-select — extend the `Set<number>` selection with
range/additive gestures and route `applyTagMany`/`detagMany` through them. The
recovery view (local-only at P3) reads `listDirtyDrafts` from `src/lib/db.ts`.

### P3 — implementation report (done)

Status: **complete, local-only.** `pnpm --filter sparcd-tagger check` (tsc),
`pnpm test` (camtrap 39 + uploader 36 + **tagger 20**, the 5 new being the
selection model), and `pnpm --filter sparcd-tagger build` all pass. Still
nothing writes to S3 — the draft store only mutates Dexie/Zustand and `s3.ts`
keeps read scope. New dep: `@tanstack/react-virtual@^3.10.8` (already in the
lockfile from the uploader; pulled into the tagger's `package.json`).

**Overview / Focus mode split (`src/sections/Tag.tsx`).** The Tag workspace now
has a thin toolbar with two segmented controls: **Overview ⟷ Focus** and, in
Overview, **▦ Grid ⟷ ☰ List** — implementing the plan's architecture where
Overview is the primary bulk surface and Focus is the single-image drill-in.
- **Overview mode**: `[Overview | SpeciesPanel]` (2-col). The Overview fills the
  main area as a virtualized grid (default) or list. Bulk-select, then one
  species key/click applies to the whole selection.
- **Focus mode**: `[Overview(list, narrow) | focus image | SpeciesPanel]`
  (3-col) — the careful single-image workflow (pan target, metadata bar, Detag).
  Double-clicking a cell (or `Enter`) in Overview drills into Focus on that
  image.
The selection readout + "N unsaved · discard" moved from the old strip header
into the toolbar.

**Virtualized Overview (`src/components/Overview.tsx`).** One reusable component
backs both the wide Overview and the narrow Focus-mode strip. It flattens the
burst grouping into a single array of `band` / `row` items (a `row` holds one
image in list mode, up to `cols` images in grid mode) and drives a single
`@tanstack/react-virtual` vertical virtualizer, so a 5,000-image upload only
mounts the visible cells (the 60fps perf target). Grid columns derive from the
measured container width via a `ResizeObserver` hook. `rowOfImage[]` maps an
image index back to its flat row so keyboard focus calls `scrollToIndex(...,
{align:'auto'})` — visible cells don't jump. Each cell subscribes only to its
own draft (`useDraftStore((s) => s.drafts[key])`), so tagging one image never
re-renders its neighbours on top of virtualization already bounding the count.
**Trade-off:** the P1/P2 strip had CSS-`sticky` burst bands; in the virtualized
(absolutely-positioned) list true stickiness doesn't work, so bands now scroll
inline. If a persistent "current burst" header is wanted, add a separate sticky
overlay reading `grouping.burstOf[focus]` — deferred.

**Full multi-select (`src/lib/selection.ts` + `Tag.tsx` `pick`).** Pure,
tested helpers (`rangeSet`, `toggleIndex`, `burstIndexSet`,
`isRangeFullySelected`) extend the `Set<number>` model. Mouse gestures on a
cell: plain click = single (focus + clear selection + set anchor); **Shift+click
= range** from the anchor; **Cmd/Ctrl+click = additive toggle**; the band
**select** button and `Cmd/Ctrl+A` = whole-burst. An `anchor` index (the last
single pick / nav target) is the base for Shift-range; `J`/`K`/`Shift+J/K` all
re-anchor through a shared `focusMove`. All paths route through the existing
`applyTagMany`/`detagMany`/`setQuestionableMany` batch store methods (one Zustand
`set`, one debounced Dexie write per target).

**Effective-tag helper extracted (`src/lib/effective.ts`).** `effectiveOf`
(draft-wins-over-base) + `isEditedFromBase` moved out of `Tag.tsx` so the
Overview cells and the Focus view read tags identically. No behaviour change.

**Local recovery view (`src/sections/Recovery.tsx`, History tab).** Replaces the
History placeholder. Reads `listDirtyDrafts()` and groups dirty drafts by upload
(`bucket::uploadPrefix`), showing per-upload unsaved/tagged counts and last-edit
time. **Open →** sets `selectCollection(bucket::uuid)` then
`selectUpload(prefix)` (which switches to the Tag workspace); **Discard** runs
the draft store's `discardUpload`. It re-derives when the in-memory `drafts`
change so edits/discards refresh the list live. This is the **local-only**
recovery the plan scopes to P3; the S3 snapshot/version recovery (loading prior
canonical snapshots) stays P5 and is noted as such in the view's copy.

**Tests.** `test/selection.test.ts` covers the four selection helpers
(range both directions, non-mutating toggle, burst membership + out-of-range,
fully-selected predicate). The data-shape contracts remain in `@sparcd/camtrap`;
virtualization/gesture wiring is UI and verified by build + manual check.

**Deliberate deferrals (for the P4+ agent):**
- **Sticky burst bands in the virtualized view** (see trade-off above) — bands
  scroll inline now.
- **Time-correction UI still unbuilt** (carried from P1/P2). `drafts.timeOverride`
  + `uploads.timeOffset` persist; the offset/override editors and feeding
  corrected timestamps into `groupBursts` remain a separate pass.
- **`react-hotkeys-hook` / `react-zoom-pan-pinch` still unused.** The single
  ref-backed `window` handler carries the keyboard set; the Focus image is a
  plain `object-contain <img>` (no pan/zoom yet) — a Focus-view polish task.
- Live CORS / `species.json` presence remains **unverified** (no credentials in
  this workspace) — same `.env` + `pnpm --filter sparcd-tagger dev` check P0–P2
  flagged. Eyeball grid scrolling and multi-select against a real upload there.

**For the P4 agent:** the local-only build is feature-complete (Overview/Focus,
grid/list, full multi-select, recovery). P4 is the first S3 write path: add
`replaceIfUnchanged` to `@sparcd/s3-safe`, the conditional canonical
replacement + immutable snapshot + per-object resume journal sync, and ground
drafts on the canonical ETags/hashes (the `base*ETag/Hash` fields already exist
in the Dexie v1 schema, so no schema bump). The merge helpers in
`@sparcd/camtrap` (`mergeMedia`/`mergeObservations`/`applyUploadMetaEdit`) and
the `MediaEdit`/`ObservationInput` shapes are ready. Keep all S3 access behind
`src/lib/s3.ts`; do not import `@aws-sdk/client-s3` in app code.

### P4 — implementation report (done)

Status: **complete — the first S3 write path, dry-run by default.** `pnpm check`
(now **5** workspaces — `@sparcd/s3-safe` gained a `check`/`test` script),
`pnpm test` (camtrap 39 + uploader 36 + s3-safe **5 new** + tagger **38**, the
18 new being 12 sync + 6 journal), and `pnpm --filter sparcd-tagger build` all
pass. The default Vitest suite still runs fully offline — every S3/Dexie effect
is injected, so no test touches a real bucket. The read path still cannot write:
`getClient` constructs a read-scoped `SafeS3Client`, and the only write-capable
client (`getWriteClient`) is built lazily *inside* the live-write IO closures, so
a dry-run never even constructs one.

**Wrapper extension — `@sparcd/s3-safe` (`replaceIfUnchanged`).** Added the one
reviewed conditional-overwrite method: `replaceIfUnchanged(bucket, key, body,
{ etag, contentType? })` → `PutObject` with `IfMatch: <etag>`, returning the new
ETag. A stale ETag (412) throws the new typed **`ConditionalReplaceConflictError`**
(distinct from `PreconditionFailedError`, which stays the `IfNoneMatch`
"already exists" case); a backend that won't enforce `IfMatch` (501) throws
`ConditionalPutUnsupportedError`. **No fallback to an unconditional PUT, ever.**
The package now has a `tsconfig.json`, `test`/`check` scripts, and
`test/replace-if-unchanged.test.ts` (mocks the internal client's `send`): proves
the `IfMatch` header is sent, a 412 is a typed conflict with no second attempt,
501 → unsupported, an empty write-allowlist refuses before any network call, and
only `PutObjectCommand`s are ever issued. README updated with the method, the
`IfMatch` semantics, and the **backend-enforcement P4 deployment gate**.

**Data path — pure + injected-IO, fully testable (`src/lib/sync.ts`,
`syncJournal.ts`, `hash.ts`).**
- `buildSyncPlan(images, drafts, offset)` diffs drafts against the canonical base
  into `@sparcd/camtrap` `MediaEdit`s: classifies add / modify / remove /
  time-correction, **ignores a draft that equals its base** (re-applying the same
  species, or a questionable-only toggle, is not a canonical change), and splits
  tag edits (→ `mergeObservations` + delta) from time-only edits (→ `mergeMedia`
  only, so an untagged-but-time-shifted image never loses its observation rows).
- `runSync(params, io)` is the orchestrator. Fresh path: re-load canonical →
  **pre-write conflict check** (current ETag vs the grounded base, per file) →
  build merged bodies against current (`mergeMedia`/`mergeObservations`/
  `applyUploadMetaEdit`; only files whose bytes actually change are written, and
  `UploadMeta.json` always changes because every successful sync appends the
  mandatory `Edited by … on …` comment) → **dry-run returns the planned writes +
  snapshot prefix and stops** → live: immutable snapshot (manifest last, **+1s
  re-stamp on a 412 collision, retry once**) → journal → conditional
  `replaceIfUnchanged` of media → observations → UploadMeta, recording each new
  ETag → clear journal. A mid-write 412 returns a conflict (journal left for
  resume); a 501 returns `unsupported`.
- `syncJournal.ts` owns the per-object resume journal (each object carries its
  `baseETag`, the exact `body`, `intendedHash`, status, newETag) and the pure
  `planResume`: a `written` object must still hash to its intent (else another
  writer touched a partially-synced object → conflict repair), a `pending` object
  must still match its base ETag (else stale → conflict), otherwise continue from
  the first pending object. The journal stores bodies so a resume after a browser
  reload can finish without the in-memory drafts.
- `hash.ts` is SHA-256 over Web Crypto — **no new dependency** (the cast at the
  `crypto.subtle.digest` call is only the lib's `BufferSource` generic friction).
- Tests: `test/sync.test.ts` (plan classification incl. detag/questionable-only/
  time-only; dry-run writes nothing; noop; live happy path with snapshot-set +
  manifest-last + in-order conditional replace + journal cleared; pre-write
  conflict; **+1s snapshot re-stamp**; 501 unsupported; **resume from a journal**;
  **reader-listing contract** — every snapshot object is a non-image under
  `.sparcd-tagger-snapshots/`) and `test/syncJournal.test.ts` (the resume planner
  + ETag collection).

**S3 IO + Dexie grounding (`src/lib/s3.ts`, `db.ts`, `queries.ts`,
`syncRunner.ts`).** `loadCanonicalState` loads all three files with ETag + hash;
`makeSyncIO` wires `writeImmutable` (snapshots) and `replaceIfUnchanged`
(canonical) behind the lazy write client. **Grounding is owned by the Tag
workspace query**: `useTagImages` now loads `loadCanonicalState` and calls
`groundUpload`, which records the canonical ETags/hashes into the `uploads`
record *together with* the on-screen data — so the base and what the user edits
never drift (a remote change that triggers a refetch re-grounds at the same
moment). The draft store's old `uploads.put` side-effect was removed (grounding
owns that record; `timeOffset` is preserved across re-grounds). Dexie went to
**v2** for an additive `syncJournals` store (the `base*ETag/Hash` fields needed
no bump as predicted, but the resume journal is a new store — a purely additive
`version(2)` with no upgrade callback). `syncRunner.performSync` is the
React-free glue: pull grounded base + offset + any resume journal, run, and
re-ground on the freshly written state; on success the UI clears draft `dirty`
(`markUploadSynced`) and invalidates the `tagImages` query.

**Sync UI (`src/components/SyncDialog.tsx`, store, Tag toolbar).** A "Sync…"
button in the Tag toolbar opens the dialog, which **previews via a forced
dry-run** (so the preview itself writes nothing) — showing the add/change/remove/
time-corrected counts, the planned files, and the snapshot prefix — then lets the
user run it. The persisted **dry-run default (Settings) is on**; turning it off is
the only way to perform the in-place replacement. The **conflict view** offers
"Discard local & reload" (drops drafts + re-grounds) or "Keep editing"; a live
sync requires a non-empty Tagger identity (Settings) since it stamps the snapshot
path + edit comment. The Chrome `StatePill` is now fed real states
(`syncing`/`dry-run`/`synced`/`conflict`/`error`), reset to `local-only` when the
upload changes.

**Open questions #1–#3 — addressed in code, with #2/#3 still live-credential
gates.** #1 (identity): prompt-and-persist via the Settings `taggerUser`,
required before a live sync. #2/#3 (write-allowed credentials + `IfMatch`/
`IfNoneMatch` backend enforcement): the code sends the headers and treats
non-enforcement as a hard `unsupported`/conflict (never a silent
last-writer-wins downgrade), but **no live write or `IfMatch` preflight has been
run against the target endpoint** — there are no write-capable credentials in
this workspace. The P4 design gate (canonical sync stays disabled where `IfMatch`
isn't enforced) is honored by the `ConditionalPutUnsupportedError` → `unsupported`
path; proving enforcement on the project's MinIO/R2 endpoint and recording the
versions in the `@sparcd/s3-safe` README remains the deployment gate.

**Deliberate deferrals (for the P5 agent):**
- **Conflict resolution is discard-or-cancel, not a 3-way merge UI.** The plan's
  richer "local-vs-remote media/observation/meta diff" view is deferred; P4
  surfaces which file changed + why and lets the user discard-and-reload or keep
  editing (and export). The pre-write/journal conflict *detection* is complete.
- **Time-correction UI still unbuilt** (carried from P1–P3). `buildSyncPlan`
  already consumes `uploads.timeOffset` + `drafts.timeOverride` and emits the
  `media.csv` col-4 / observation col-4 corrections (tested), so the offset/
  override editors just need to write those fields.
- **Multi-species rows.** Single label per image (the v1 Dexie schema); the merge
  side (`MediaEdit.observations[]`) already accepts arrays.
- **`loadObject` HEAD-then-GET** grounds ETag and bytes in two calls; a change
  between them can only cause a spurious sync conflict (safe-fail), never a bad
  write. A single atomic `GetObject`-with-ETag read method would remove the
  window if it matters.
- Live CORS / `species.json` presence / `IfMatch` enforcement remain
  **unverified** (no credentials) — same `.env` + `pnpm --filter sparcd-tagger
  dev` check P0–P3 flagged; additionally do a real dry-run then a real sync
  against a write-allowed test bucket and confirm the snapshot + canonical
  replacement land.

**For the P5 agent:** snapshot/version recovery. The snapshot subtree
(`<uploadPrefix>.sparcd-tagger-snapshots/<user>/<stamp>/` with `media.csv`,
`observations.csv`, `UploadMeta.json`, and a `manifest.json` written last) is the
recovery source — list prefixes, ignore any without a complete manifest, load a
chosen snapshot into local, and restore through the same `replaceIfUnchanged`
flow (`runSync` already grounds + journals, so a restore is "sync these bodies").
The History/Recovery view (`src/sections/Recovery.tsx`) is the place to surface
remote snapshots alongside the local dirty drafts it already shows.

### P5 — implementation report (done)

Status: **complete — snapshot/version recovery, restore reuses the P4 write
path.** `pnpm --filter sparcd-tagger check` (tsc), `pnpm test` (camtrap 39 +
uploader 36 + s3-safe 5 + **tagger 46**, the 8 new being `restore.test.ts`), and
`pnpm --filter sparcd-tagger build` all pass. The default Vitest suite still runs
fully offline — restore I/O is injected through the same `SyncIO` fakes the sync
tests use. No new deps. A restore writes to S3 only on the live (dry-run-off)
path, exactly like a sync.

**Restore is a sync with snapshot bodies instead of merged drafts
(`src/lib/sync.ts`).** Refactored `runSync` so sync and restore share one
live-write path, then added `runRestore`:
- Extracted `tryResume` (the per-object journal resume block, formerly inline in
  `runSync`) and `commitWrites` (immutable snapshot → journal → in-order
  conditional `replaceIfUnchanged`, with the +1s re-stamp on a 412 collision).
  `runSync`'s behaviour is unchanged — its 13 tests still pass against the
  refactor.
- `runRestore({ bucket, uploadPrefix, user, bodies, dryRun, resumeJournal }, io)`
  loads the current canonical, keeps only the snapshot bodies whose bytes differ
  from current (`prepareWrites`, also factored out of `buildWrites`), and writes
  them back **verbatim** through `commitWrites`. Key decisions:
  - **Exact rollback, no merge.** The snapshot `media.csv` / `observations.csv` /
    `UploadMeta.json` are restored byte-for-byte — no re-derived `UploadMeta`
    tally, no appended edit comment. The restored state is exactly the snapshot.
  - **`IfMatch` against the *current* remote ETags**, not the snapshot's — a
    concurrent write since the restore began is caught as a conflict, never
    clobbered.
  - **The current (pre-restore) state is snapshotted first** via the same
    `commitWrites` snapshot step, so a restore is itself recoverable.
  - Exported `SnapshotManifest` type (the shape `writeSnapshotSet` writes and the
    reader below consumes) so writer and reader can't drift.

**Snapshot listing + body loading (`src/lib/s3.ts`).** `listSnapshots` walks the
two snapshot levels (`<user>/<stamp>/`) with `listCommonPrefixes` and reads each
`manifest.json`; a stamp prefix whose manifest is **absent or unparseable is
skipped** (the manifest is written last, so a partial/abandoned snapshot has
none — the plan's "recovery ignores prefixes without a complete manifest"
contract). Returns `SnapshotRef[]` newest-first. `loadSnapshotBodies` GETs the
three canonical files of a chosen snapshot. Both go through the read-scoped
client and reuse the uploader's CORS error translation.

**Runner glue (`src/lib/syncRunner.ts`).** `performRestore` loads the snapshot
bodies, picks up any prior partial journal for the upload, runs `runRestore`, and
on a successful live write re-grounds on the now-restored canonical state. Note:
the resume journal is keyed `${bucket}::${uploadPrefix}` and shared by sync and
restore — a pending journal (from either) must be finished (or its conflict
resolved) before a new write begins; since the journal stores the exact bodies,
resuming always completes the originally-intended write safely. Documented in
`tryResume`/`performRestore`.

**Restore UI (`src/components/SnapshotsDialog.tsx`, Tag toolbar).** A
"Snapshots…" button in the Tag toolbar (next to "Sync…") opens a dialog listing
the upload's recoverable snapshots (stamp · user · file count). Picking one opens
a restore pane that **previews via a forced dry-run** (writes nothing), shows
which files would be restored + where the current state will be snapshotted, then
restores it — gated on the persisted **dry-run default** and a non-empty Tagger
identity, and surfacing the same conflict view as the sync dialog
(discard-and-reload / keep editing). The Chrome `StatePill` is fed the same
states a sync produces.

**Recovery section copy (`src/sections/Recovery.tsx`).** Updated to point at the
per-upload "Snapshots…" action. Restore lives in the **Tag workspace** (not the
History/Recovery list) because it needs the upload's bucket/prefix/identity
context, which the dirty-draft list doesn't carry; a cross-upload snapshot
browser is the **P6 History** section's job (the phase table already assigns
"History (surfaces the P5 recovery capability)" to P6).

**Deliberate deferrals (for the P6 agent):**
- **Cross-upload snapshot browser in History.** P5 surfaces restore per-upload in
  the Tag workspace; the History section listing snapshots across uploads
  (alongside the local dirty drafts it already shows) is P6.
- **Restore does not reconcile local drafts.** After a live restore the canonical
  base changes and the workspace re-grounds + refetches, but existing local
  drafts are left intact (they now diff against the restored base). Marking them
  clean would be wrong since they may still differ; the user re-syncs or discards.
- **Exact-rollback vs. audited restore.** A restore intentionally writes the
  snapshot bytes verbatim (no "Restored by … on …" edit comment), so the result
  is byte-identical to the snapshot. If an audit trail of *restores* (not just
  syncs) is wanted in `UploadMeta.editComments`, that's a deliberate future
  divergence, not a bug.
- Live CORS / `species.json` presence / `IfMatch` enforcement remain
  **unverified** (no credentials) — same `.env` + `pnpm --filter sparcd-tagger
  dev` check P0–P4 flagged; additionally exercise a real sync (to create a
  snapshot) then a real restore of it against a write-allowed test bucket.

### P6 — implementation report (done)

Status: **complete — the internal navigation sections are finished; reads only.**
`pnpm --filter sparcd-tagger check` (tsc), `pnpm test` (camtrap 39 + uploader 36
+ s3-safe 5 + tagger 46, unchanged), and `pnpm --filter sparcd-tagger build` all
pass. P6 adds no write path — the only new S3 calls are `listCommonPrefixes` +
`getObject(manifest.json)` reads, on the read-scoped client. With P6 the
phased delivery table is fully delivered.

**Cross-upload snapshot browser — the P5 handoff item (`src/sections/Recovery.tsx`,
the History tab).** The History section was a single local-dirty-draft list; it
is now two clearly-labelled recovery surfaces:
- **Unsynced local edits** — the existing dirty-draft browser (unchanged
  behaviour: `listDirtyDrafts` grouped by upload, Open → routes to the Tag
  workspace, Discard runs `discardUpload`), refactored into a `LocalEdits`
  subcomponent.
- **Synced snapshots** — a new `Snapshots` subcomponent that lists every upload
  in a collection that has a recoverable snapshot, newest upload first, each
  upload expanded into its individual snapshots (pretty stamp · user · file
  count). A collection `<select>` scopes the view, defaulting to whatever the
  user last drilled into (`selectedCollectionKey`) and falling back to the first
  discovered collection. **Restore stays in the Tag workspace** (it needs the
  upload's bucket/prefix/identity context): a per-upload "Restore… →" routes
  there via the new `openUploadForSnapshots` store action.

**Routing into the per-upload restore dialog (`src/store.ts`, `src/sections/Tag.tsx`).**
Added a one-shot `pendingSnapshots` flag + `openUploadForSnapshots(collectionKey,
uploadPrefix)` / `clearPendingSnapshots` actions. `openUploadForSnapshots` sets
collection + upload + `section: 'tag'` atomically (a plain `selectCollection`
resets the upload, so it can't be reused here) and raises the flag; the Tag
workspace consumes it once in an effect to auto-open its existing
`SnapshotsDialog` (the P5 dry-run-first, conflict-aware conditional-replacement
restore), then clears it. So History is the cross-upload *discovery* surface and
the Tag dialog remains the single restore code path — no duplicate restore flow.

**S3 + query plumbing (`src/lib/s3.ts`, `src/lib/queries.ts`).**
`listCollectionSnapshots(cfg, bucket, uuid)` lists the collection's uploads
(`listUploads`) and maps `listSnapshots` over them, dropping uploads with no
complete snapshot; a per-upload listing failure (e.g. a CORS-blocked prefix) is
swallowed so one bad upload doesn't hide the rest. Surfaced via the
`connectionId`-scoped `useCollectionSnapshots` query (same caching discipline as
every other read). Fan-out is fine for the Educational Test collection; a very
large collection would issue one snapshot-walk per upload — noted below.

**Browse + Settings.** Reviewed; both were built complete in P0 (Browse:
collection → upload → presigned image grid + species-vocabulary status line;
Settings: identity, dry-run default, burst threshold, connection/disconnect) and
needed no change for P6. Left untouched deliberately rather than churned.

**No new tests.** The new code is read-IO orchestration (`listCollectionSnapshots`)
and UI wiring (History sections, store flag, Tag effect); consistent with P3/P5,
UI/IO glue is verified by `check` + `build` + manual check, and the pure-logic
contracts already covered (`groupDirty` grouping, snapshot manifest filtering in
`listSnapshots`) are unchanged. `prettyStamp` is intentionally duplicated between
`SnapshotsDialog.tsx` and `Recovery.tsx` (per-feature duplication over a shared
helper, per the repo style note).

**Deliberate deferrals / notes (for whoever takes this past MVP):**
- **Snapshot fan-out at scale.** `listCollectionSnapshots` walks every upload's
  snapshot prefix. Fine for the test collection; a collection with hundreds of
  uploads would want a cheaper index (e.g. a per-collection snapshot manifest)
  or lazy per-upload expansion. Not built — no large collection to justify it.
- **Restore still lives in the Tag workspace.** History routes there rather than
  restoring inline, because restore writes and needs the upload's
  bucket/prefix/identity. This is the intended split, not a gap.
- **Time-correction UI still unbuilt** (carried from P1–P5). The data fields and
  the sync emit path exist; the offset/override editors are the main remaining
  pre-MVP feature outside the phased table.
- Live CORS / `species.json` presence / `IfMatch` enforcement remain
  **unverified** (no credentials) — same `.env` + `pnpm --filter sparcd-tagger
  dev` check every prior phase flagged; with P6 done, the full end-to-end pass
  to run against a live write-allowed test bucket is: browse → tag → sync (dry
  then live) → confirm snapshot appears in History → restore it.

### Time correction UI — implementation report (done)

Status: **complete — design §08 built; the standing "time-correction UI unbuilt"
deferral carried through P1–P6 is closed.** `pnpm check` (5 workspaces), `pnpm
test` (camtrap **40** + s3-safe 5 + uploader 36 + tagger **57**), and `pnpm
--filter sparcd-tagger build` all pass. Built test-first against the upstream
Java app, per the no-regression workflow.

**Data-correctness fix first — `@sparcd/camtrap.shiftTimestamp` now matches Java.**
Reviewed `Sanimal FX/.../controller/importView/TimeShiftController.java`: the
offset is applied as `LocalDateTime.plusYears(y).plusMonths(mo).plusDays(d)
.plusHours(h).plusMinutes(m).plusSeconds(s)`, where `plusYears`/`plusMonths`
**clamp** the day-of-month to the last valid day (Jan 31 +1mo → Feb 28/29) and
the two clamps are **sequential**. The old `shiftTimestamp` used JS
`Date.setUTCMonth`, which **overflows** (Jan 31 +1mo → Mar 2/3) — and a test was
*asserting* the overflow value as intended. Since the corrected time is written to
`media.csv` col 4 and read by Java/sparcd-web, Java is the contract. Rewrote the
helper to mirror Java's sequential clamping (exact-duration day/h/m/s after the
clamp) and rewrote the `contracts.test.ts` boundary cases to encode Java's
semantics (leap clamp, non-leap clamp, leap-day +1y, the order-dependent
+1y+1mo case, negative wrap). Safe to change now: no time-correction UI had
shipped, so no offset had ever been written.

**UI (all on the now-verified data path; no new contract surface).**
- `lib/timeshift.ts` (pure, tested): `offsetActive`, `formatOffsetDelta`
  (`+1h` / `-1d +7h -30m` / `no shift`), `normalizeTimestampInput` (accepts
  space-or-`T`, optional seconds, range-validates → canonical naive ISO or null).
- `TimeShiftModal` (upload-level): signed y/mo/d/h/m/s spinners + live
  original→corrected preview using `shiftTimestamp`. Writes
  `uploads.timeOffset` via the new draft-store `setTimeOffset` →
  `db.setUploadTimeOffset` upsert.
- `PerImageTime` (Focus): corrected prominent + original struck-through +
  `shifted`/`image override` badge + inline "Adjust time" editor + clear-override,
  writing `drafts.timeOverride` via `setTimeOverride` (marks the draft dirty).
- Tag toolbar: a `◷ Time shift` entry that becomes a filled `◷ clock <delta>`
  active-offset indicator when an offset is set (the design's ClockChip role).
- Display: the focused image shows its corrected time; burst grouping takes an
  optional `tsOf` accessor so band spans read corrected times (a uniform offset
  never changes a gap, so grouping itself is stable; kept off the per-keystroke
  draft path).

**Double-apply guard (the one real data risk in the feature).** The upload
offset is *relative* (`base + offset`); after a successful live sync bakes the
corrected times into `media.csv`, re-grounding makes the new base the corrected
value — so a standing offset would shift *again* next sync. `performSync` now
clears `uploads.timeOffset` on a successful live sync (and `SyncDialog` resets the
in-memory value so the indicator clears). Per-image overrides are *absolute*, so
they are idempotent and need no reset.

**Tests.** `test/timeshift.test.ts` (7: format/active/normalize) and a `tsOf`
case in `test/bursts.test.ts`. The offset-clearing in `performSync` is Dexie glue
(verified by `check`/`build` + the live checklist, consistent with P1–P6 norms);
the correctness-critical date math and the time-only sync path are unit-tested in
`@sparcd/camtrap` + `test/sync.test.ts`.

**Still unverified (carried):** live CORS / `species.json` / `IfMatch`
enforcement — plus, now, a live check that an upload shift + a per-image override
round-trip into `media.csv` col 4 and read back correctly in the Java app /
sparcd-web. Multi-species per frame remains deliberately deferred (single label
per image); the `@sparcd/camtrap` merge layer already supports N rows/image.

## Open questions for before P0

1. **User identity for snapshots and edit comments.** The IAM access key
   stamps the bucket-side writer; the tagger also needs a logical `userId` for
   audit snapshot paths and mandatory `UploadMeta.json.editComments` entries.
   Options: prompt at session start, derive from access key, or pin to a
   config file. Lean: prompt + persist.
2. **First write-allowed bucket/credentials.** Not a build-time allowlist
   (that idea is gone — see Static BYO-S3 security contract); a concrete
   credential set whose IAM policy permits conditional `PUT` on canonical
   `media.csv` / `observations.csv` / `UploadMeta.json` and immutable snapshot
   writes on a real bucket, so P4 has somewhere to test compatibility writes.
3. **Conditional replacement backend support.** Verify the target MinIO/R2/S3
   endpoints enforce `IfMatch` on `PutObject` from browser SDK calls and expose
   enough `HEAD` metadata/ETag via CORS. This is a P4 go/no-go gate: if a
   backend cannot enforce this, P4 does not write canonical metadata on that
   backend. The plan does not allow an automatic fallback to Java's
   unconditional overwrite behavior.
4. **Ghost/Casper counting semantics.** Compatibility default is that
   Ghost/Casper counts as species-present because Java treats any non-empty
   `speciesPresent` as tagged. Confirm before P0 that this is the intended
   user-facing meaning; otherwise the plan must document the intentional Java
   divergence and fixture expectations.

## Out of scope (explicit, for future tools)

- Image upload (tagger reads only; new images come from SPARC'd's upload
  flow)
- User management / permissions admin
- Species hierarchy admin
- Bulk export to formats other than Camtrap-DP CSV
- Map / spatial reports (that's the marimo explorer's job)

### Future ideas (post-MVP, noted so they aren't lost)

- **Automated ghost _prediction_ as an add-on.** Manual Ghost tagging is a
  core MVP label (see Species / label autocomplete) — this future item is
  only the *automated* part. A separate offline pass (e.g. the existing TF
  "Ghost" detector) would write a per-image predictions sidecar; the tagger
  could *optionally* consume it as advisory hints — pre-select likely-empty
  frames for the human to confirm with `G`, never auto-tag or auto-discard.
  No pre-classifier is in scope for MVP. Keep an optional per-image prediction
  slot in the data model, but the tagger works fully without it.
- **Guided tour / first-run walkthrough.** A short interactive tour of the
  overview → focus → tag → sync flow for new users. Out of scope for MVP.
