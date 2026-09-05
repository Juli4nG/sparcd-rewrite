# Issue #82 — missing EXIF capture time: assessment and implementation spec

Sources: [issue #82](https://github.com/CulverLab/sparcd-exploration/issues/82),
[discussion #27](https://github.com/orgs/CulverLab/discussions/27),
[discussion #8](https://github.com/orgs/CulverLab/discussions/8),
uploader code on `feature/the-flip` (2026-09-03).
UI diff mockup: `docs/ui-diff-issue-82.html`.

## What was decided in the threads

- Upload never blocks on a missing time (Juli4nG, #8 and #27; nobody disagreed).
- The rule (Chris-Schnaufer, #27, carried into #82): interpolate between the
  neighbouring images; if first or last, 10 minutes from the nearest image; if no
  reference image, use the file created date; mark every such time as a known issue.
- Persistence named in both threads: Camtrap-DP `deployments.timestampIssues`.
- Not decided: what the UI shows, and whether a per-file marker exists in addition
  to the deployment-level flag. The interface sketch linked from #8 (2026-08-01,
  "Setting capture times on 5,000 images without 5,000 date pickers") is
  reconciled in the last section below.

## What the uploader does today

- Worker reads `DateTimeOriginal ?? CreateDate ?? ModifyDate` (images) or the MP4
  `mvhd` creation time (videos). Absence leaves `exifNaive` undefined.
  `apps/sparcd-uploader/src/workers/fileProcessor.worker.ts:59-97`
- Inspect shows a warning dot, "No capture time — set one in Assign", and an
  empty timestamp cell. `src/lib/validation.ts:38-40`, `src/components/FileList.tsx:154`
- Assign shows `CaptureTimeEditor`, a must-fill panel with bulk set plus one
  `datetime-local` per file. `src/components/CaptureTimeEditor.tsx`
- The hard gate `captureTimeComplete` disables Continue until every file has an
  EXIF or manual time. `src/lib/validation.ts:76-78`, `src/sections/Assign.tsx:122`
- Bundle resolves `exifNaive ?? manualNaive` and writes
  `deployments.csv` `timestamp_issues` as the literal `false`, and `media.csv`
  `comments` as empty. `src/lib/bundle.ts:183-186`,
  `packages/camtrap/src/index.ts:87-88,120-127`
- Upstream sparcd-web writes an empty timestamp in this case and sets no flag.
  Camtrap-DP requires `media.timestamp`; the only issue flag in the standard is
  the deployment-level boolean. No surveyed tool (camtrapR, Agouti, TRAPPER,
  Wildlife Insights) interpolates; TRAPPER and Camtrap-DP flag at deployment level.

So the current gate is exactly the thing both discussions argued against, and
this issue replaces it. The existing panel, timezone handling, and marker
convention give everything needed; no new screen or button is required.

## The correct implementation

### Rule, with three refinements to the issue text

1. **Position by filename, not timestamp.** A file with no time cannot be sorted
   by time, so its neighbours are the nearest files with a camera time in
   natural filename order of `relPath` (folder then name), across the whole batch.
   Camera-trap counters make this the capture order in practice.
2. **Spread a run evenly.** For k consecutive files with no time between A and B,
   place them at A + i·(B−A)/(k+1). The issue says "between the two"; the midpoint
   for all k would give identical times and ties in the tagger's sort.
3. **Inverted neighbours count as "cannot be determined".** If the previous
   reference is later than the next one, fall through to the file-modified fallback
   for that file rather than interpolating backwards.

Ends: 10 minutes after the last reference or before the first, keeping filename
order within a run (10, 20, 30 minutes). No reference in the batch: browser
`File.lastModified` (the only creation-ish date a browser exposes; copying off
an SD card preserves it), converted to wall-clock in the upload timezone so it
flows through the existing naive-in-zone path.

Precedence stays `exifNaive ?? manualNaive ?? estimate`. Manual entry is now an
override, never a requirement.

### Persistence

- `deployments.csv` `timestamp_issues` = `true` when any file in the batch is
  estimated. This is the field both threads named and the Camtrap-DP meaning fits.
- `media.csv` `comments` (col 10) gets a per-file marker in the existing
  `[PREFIX:value]` convention: `[TIMESTAMP:interpolated]`, `[TIMESTAMP:offset]`,
  `[TIMESTAMP:file-modified]`, `[TIMESTAMP:spread]`, or `[TIMESTAMP:manual]`. Every
  time the camera did not write is flagged, including hand-entered ones, so the
  deployment flag is simply "any file without a camera time". The deployment flag alone cannot tell the tagger
  which files to badge. Free text in a Camtrap-DP comments column is safe for
  upstream readers.
- `UploadMeta.json` unchanged.

### UI (see the mockup)

- Inspect: timestamp cell fills in with the estimate plus an `EST.` tag; the
  warning stays with new wording; the header line gains "N estimated times".
- Assign: `CaptureTimeEditor` is rebuilt in the shape of the #8 sketch. Scope
  rail on the left (all estimated, per folder, has camera time). Two operations:
  Interpolate, the automatic default with nothing to enter, and Spread (first
  image time plus spacing in file order, or file modified times) as the override
  for a set with no usable neighbours. A camera-time range strip shows where the
  estimates land. Affected files are a thumbnail grid with the estimate and its
  method; clicking one overrides it, clear returns to the estimate. Continue is
  no longer gated on capture time. Spread replaces today's single-value bulk
  set, which writes identical timestamps to every file.
- Upload preview: `timestamp_issues true` and the comment marker are visible.
- Tagger: `PerImageTime` shows an `ESTIMATED` badge next to the time, in the
  style of the existing `shifted` badge. Correcting the time already exists there.

None of this appears for a batch where every file has a camera time.

## Code plan

Uploader (`apps/sparcd-uploader`):

- New `src/lib/estimateCaptureTime.ts`: pure
  `estimateCaptureTimes(files, timeZone) → Map<id, {naive, method, refs}>`.
  Built once at Assign→Upload alongside `BatchNaming` and passed into
  `planItemFor`, so streamed enqueueing sees the whole ready set. The same
  function backs a memoized selector for Inspect and Assign display.
- `src/lib/bundle.ts`: `captureFor` takes the estimate map; `UploadItem` gains
  `timestampEstimated?: method`; deployment build sets `timestampIssues` when any
  item is estimated; media build writes the marker.
- `packages/camtrap/src/index.ts`: `timestamp_issues` from input instead of the
  literal; media `comments` from a `buildMediaComments` helper; export a
  `TIMESTAMP_PREFIX` constant and a `timestampEstimatedFromComments` reader for
  the tagger.
- New `src/lib/spreadCaptureTimes.ts`: pure spread over a selection (start naive,
  spacing seconds, or file modified times), stored as `manualNaive` per file so
  precedence and the marker (`offset`) stay the same.
- `src/lib/validation.ts`: drop `captureTimeComplete`; reword the warning;
  add `estimated` to `BatchSummary`.
- `src/components/CaptureTimeEditor.tsx` rebuilt (scope rail, two tabs, range
  strip, thumbnail grid); `FileList.tsx`, `sections/NewUpload.tsx`,
  `sections/Assign.tsx`, `components/MetadataPreview.tsx`: the smaller changes.
- Tests: new `test/estimateCaptureTime.test.ts` (midpoint, even spread, both
  ends, no reference, inverted neighbours, timezone of the fallback);
  `test/bundle.test.ts` for the two CSV cells; `test/validation.test.ts` for the
  gate removal. Rewrite the four manual-entry scenarios in
  `features/capture-time-and-timezone.feature`.

Tagger (`apps/sparcd-tagger`):

- `src/lib/workspace.ts`: parse the marker from media col 10 into
  `TagImage.timestampEstimated`.
- `src/components/PerImageTime.tsx`: the badge.

Roughly 450 lines plus tests. One PR, "Fixes #82". Suggested split: the lib,
bundle and camtrap changes plus tests to gpt-5.6-sol; the four UI files and the
feature rewrite to an Opus subagent; gpt-5.6-sol review before merge.

## Calls for the team

1. Per-file marker in `media.csv` comments in addition to the deployment flag.
   Recommended yes; without it the tagger cannot badge individual images.
2. Estimated files still count as a warning at Inspect. Recommended yes, so the
   count stays visible; the wording changes.
3. "File created date" means browser `lastModified`. There is no birth time in
   the File API. State this in the PR.
4. Spread ships with #82 or as a follow-up. Recommended with #82: it is the only
   way to override a whole folder, and the bulk set it replaces is worse.

## Out of scope, worth their own issues

- Reset-clock offsets (Juli4nG's scenario 2 in #8): the tagger's upload-wide
  shift already covers correction; the uploader needs nothing.
- Files where only `ModifyDate` was available are silently trusted today.
- Whether a tagger correction should clear the marker and, once no estimated
  files remain, the deployment flag.

## Reconciled with the #8 sketch

The sketch predates Chris's rule in #27 by three weeks. The rule absorbed two of
its three operations as automatic defaults; the rest is already in the tagger
or folded into the Assign panel above.

| In the sketch | Here |
| --- | --- |
| Interpolate from neighbours | Automatic default, the #82 rule. |
| Spread over window (start + spacing, or file modified times) | The override operation. File modified time is #82's no-reference fallback. |
| Anchor & shift | Already the tagger's time shift (`apps/sparcd-tagger/src/lib/timeshift.ts`, selection-scoped, anchored on the earliest corrected time). Wrong-but-present times pass upload checks and only surface at review. |
| Apply-to scope by folder or failure | Added; folders come from the batch's relative paths. |
| Deployment-window timeline | Reduced to a camera-time range strip. `deployments.csv` start and end are written empty today (`packages/camtrap/src/index.ts:79-80`), so there is no window to check against. |
| Affected-images grid with burn-in | The review surface, replacing the per-row date pickers. |
| Publish locked until every image has a time | Replaced by the deployment flag. Upload completes; `timestamp_issues` stays true while any file lacks a camera time. Flipping it back is a tagger follow-up. |
| "draft — not published" badge | No draft state in the uploader; the flag plays that role downstream. |
| Same panel in the tagger | Follow-up issue. |
| `timestampIssues` plus a `mediaComments` record | Kept: the flag plus the `[TIMESTAMP:…]` marker. |
