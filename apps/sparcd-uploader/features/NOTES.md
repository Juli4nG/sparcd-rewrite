# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-uploader (src/ and test/) plus packages/auth-ui, packages/s3-safe, packages/camtrap.

Coverage notes for the as-built uploader feature files.

## What is documented

- **Ten feature files**, one per coherent flow: connecting/session, choosing a
  folder, inspecting the batch, tagging species before upload, assigning
  collection + deployment, capture time and timezone, the upload run itself,
  resume/retry/History, correcting a published upload, and Settings/local data.
  Every scenario was traced to code in `src/`, and most are additionally pinned
  by a unit test in `test/`.
- Scenarios carry a story tag only where the as-built behavior genuinely
  corresponds to that story's acceptance criteria. Everything else is
  `@unmapped` — most of this app is, which is the point of the exercise.

## Story mapping, honestly

- **F1** (upload a batch once back online) — partly met: only image/video files
  are taken from the card, every object is verified after it lands, and a partly
  transferred batch is never published as complete. **No offline indicator
  exists anywhere in the app** (`navigator.onLine` is never consulted), so that
  criterion is unmet.
- **F2 / A2** (assign a camera location) — the "cannot finalize without a
  location" criterion is fully met and tested. The "only locations valid for the
  collection" criterion is **not**: as-built *any* location in the registry can
  be assigned; locations the collection has already used are merely sorted to
  the top. Flagged in a trailing comment on that scenario.
- **AL1** (interrupted uploads continue on their own) — partly met: verified
  data is not resent, and an interrupted upload is always visibly "open", never
  silently stuck. **Continuation is manual** — the user clicks Resume; there is
  no connectivity watcher and no automatic restart. Flagged in a comment.
- **AL2** (retry to the same destination) — met, and the strongest-covered story:
  the upload folder and object paths are reused verbatim, done objects are
  skipped after a size + fingerprint check, and location/identity are never
  re-entered.
- **A1** (tag species before upload) — now met, but not by this app alone.
  There is still **no tagging surface here**: the batch is handed to the tagger
  and comes back with species on it, which the uploader shows read-only and
  publishes as observation rows in the same upload. An untagged batch is still
  accepted and recorded as carrying no species. Attribution (the tagger's
  identity travelling with the tags) is recorded on the hand-off record but is
  **not written into the published data** — that criterion stays unmet.
- **F3** (announce new data) — only the negative criterion is met: a failed or
  abandoned upload publishes no metadata, so nothing sees it. There is no
  notification mechanism.
- **F4**, **H1**, **H2**, **H3** — nothing in the uploader corresponds. F4
  (sensitive-species locations) has **no implementation whatsoever**: published
  deployment metadata still carries precise coordinates with no sensitivity
  concept. The production uploader deliberately offers no metadata preview;
  its diagnostic implementation lives only on `debug/metadata-preview`. H1–H3
  belong to the tagger.

## Deliberately skipped

- `benchmark/`, `corpus/`, `plan.md`, `benchmark-plan.md`, `design-prompt.md` —
  a performance harness, fixtures, and design/planning prose, not app behavior.
- Pure display maths (UTM projection, metres→feet, byte formatting) — real and
  tested, but not requirements-level behavior.
- Layout/responsive/keyboard-affordance detail beyond where it changes what a
  user can accomplish.

## Things that were asked about but do not exist

- **Endpoint shards** — no such concept appears anywhere in the app or the
  shared packages. Nothing documented.
- **Write-scope pin** — the app hands its storage wrapper a wildcard scope for
  *both* reads and writes, so the wrapper's allowlist is not restricting
  anything here. The real controls are the credentials' own policy, bucket CORS,
  and the fact that the wrapper exposes no delete or copy operation. Documented
  as it actually is, in `connect-and-session.feature`.

## Ambiguous or half-wired, flagged rather than described as behavior

- The **upload-state pill** in the header is hardcoded to "ready" and never
  reflects a running upload. Not written up as behavior.
- **Elevation unit** (metres/feet) is stored and persisted, and the deployment
  detail popover reads it, but no UI sets it — the setter is never called.
- **Concurrency** and the **dry-run default** live on the Upload step and reset
  on every page load, despite Settings still saying they will "join here in P4".
  Documented where they actually are, with the non-persistence noted.
- `upload.ts` documents a **re-stamp-on-prefix-collision retry** and a
  `runUpload` entry point; neither exists in the shipped code. The wizard uses
  the streaming run, which treats a metadata-path collision as a hard error.
  Stale comments, not behavior.
- `db.ts` exports `saveSession`, which nothing calls. Not documented.
- **Verification depends on the backend preserving the custom `sha256`
  metadata** it set on write. If a backend dropped it, every skip check and
  post-write verification would fail rather than pass silently — worth a
  product-owner decision on whether that is the intended failure mode.
- **MP4 capture time** is read only from the leading 4 MiB of the file, so a
  non-fast-start video falls through to manual entry exactly like a file with no
  timestamp. Documented as "no camera capture time" rather than as an MP4 detail.

## Making these files executable

They now run: `pnpm test:bdd` in `apps/sparcd-uploader` generates the specs with
`bddgen` and drives the real app in Chromium, with storage served by an
in-memory S3 mock (`features/steps/s3mock.ts`). Everything the run changed about
these files — corrected claims, one `@manual` scenario, and the app bugs found
along the way — is written up in `features/CORRECTIONS.md`. Since PR #26 fixed
publishing after Inspect completes, publish scenarios use small media by
default; only scenarios about background examination keep the deliberately slow
MP4, and in-flight upload checks are held by the S3 mock.
