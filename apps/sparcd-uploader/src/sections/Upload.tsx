import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OfflineBanner, useOnline } from '@sparcd/auth-ui';
import { deleteFlipRecord } from '@sparcd/flip';
import { useStore } from '../store';
import { useLocations } from '../lib/useLocations';
import { useCollections } from '../lib/useCollections';
import { sanitizeUploaderUser } from '../lib/normalize';
import { formatBytes } from '../lib/scanFiles';
import { loadSession } from '../lib/db';
import type { ReconcileProblem } from '../lib/resume';
import {
  resumeUpload,
  runStreamingUpload,
  type ConcurrencyControl,
} from '../lib/upload';
import type { ProcessResponse } from '../lib/processPool';
import { ensureBundle } from '../lib/resume';
import { Note, RunMonitor } from '../components/RunMonitor';
import { UploadCompleteDialog } from '../components/UploadCompleteDialog';
import { CaptureTimeEditor } from '../components/CaptureTimeEditor';

const sectionLabel = 'font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft mb-2';

// Read the mode and the manual value at call time, not at render time: the
// getter is what lets a mid-run slider change reach the lane pool.
const concurrencyControl = (): ConcurrencyControl =>
  useStore.getState().concurrencyMode === 'manual'
    ? { mode: 'manual', get: () => useStore.getState().uploadConcurrency }
    : { mode: 'adaptive' };

// What "adaptive" means, on demand — the explanation only matters the first time
// someone wonders, so it stays behind the 'i' rather than sitting in the layout.
function AdaptiveInfo() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="About adaptive concurrency"
        className="shrink-0 min-w-11 min-h-11 sm:min-w-5 sm:min-h-5 grid place-items-center border border-rule text-inkSoft hover:text-ink hover:border-ink [@media(hover:none)]:text-ink [@media(hover:none)]:border-ink text-[11px] font-mono focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        i
      </button>
      {open && (
        <span className="absolute left-0 top-full z-10 mt-1 block w-[min(22rem,calc(100vw-2.5rem))] border border-rule bg-panel px-3 py-2 font-body text-[12px] leading-[1.5] text-inkSoft">
          Adaptive probes different lane counts against measured throughput and keeps whichever is
          fastest. The lane count it has settled on shows here while a run is in flight. To pin a
          fixed number instead, switch to manual in Settings.
        </span>
      )}
    </span>
  );
}

export function Upload() {
  const s3Config = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const setStep = useStore((s) => s.setStep);
  const files = useStore((s) => s.files);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const description = useStore((s) => s.uploadDescription);
  const uploadTimeZone = useStore((s) => s.uploadTimeZone);
  const selectedLocationKey = useStore((s) => s.selectedLocationKey);
  const selectedBucket = useStore((s) => s.selectedBucket);
  const dryRun = useStore((s) => s.dryRun);
  const setDryRun = useStore((s) => s.setDryRun);
  const concurrencyMode = useStore((s) => s.concurrencyMode);
  const concurrency = useStore((s) => s.uploadConcurrency);
  const setConcurrency = useStore((s) => s.setUploadConcurrency);
  const nextBatch = useStore((s) => s.nextBatch);
  const flipId = useStore((s) => s.flipId);
  const fileAccessMode = useStore((s) => s.fileAccessMode);
  const dirHandle = useStore((s) => s.dirHandle);
  const pendingResume = useStore((s) => s.pendingResume);

  const { data: locData } = useLocations(s3Config, connectionId);
  const collections = useCollections(s3Config, connectionId);

  const slug = sanitizeUploaderUser(uploaderUser);
  const location = locData?.locations.find((l) => l.key === selectedLocationKey) ?? null;
  const collection =
    collections.data?.find((c) => c.key === selectedBucket || c.bucket === selectedBucket) ?? null;
  const effectiveDryRun = dryRun;
  // A dry run never touches the network (nothing is written), so it's still
  // usable offline — only a real upload/retry needs to be gated.
  const online = useOnline();


  // Run and snapshot live in the store so they survive section navigation —
  // unmounting this component stops rendering the run, not running it. This is
  // the only step that runs anything, resumes included, so every snapshot here
  // is ours.
  const snap = useStore((s) => s.activeSnap);
  const activeRun = useStore((s) => s.activeRun);
  const activeRunReserved = useStore((s) => s.activeRunReserved);
  const beginActiveRun = useStore((s) => s.beginActiveRun);
  const setActiveRun = useStore((s) => s.setActiveRun);
  const setActiveSnap = useStore((s) => s.setActiveSnap);
  const clearActiveRun = useStore((s) => s.clearActiveRun);
  const [resumeProblems, setResumeProblems] = useState<ReconcileProblem[]>([]);
  // Files reattached by a History handoff; the store's batch is empty then, so
  // Retry has to reuse this map instead of rebuilding one from `files`.
  const attachedRef = useRef<Map<string, File> | null>(null);
  const running =
    snap?.phase === 'preparing' || snap?.phase === 'blobs' || snap?.phase === 'metadata';
  const anyRunActive = activeRunReserved;
  // Dismisses the "upload complete" popup — reset whenever a new run (fresh
  // start or resume) begins, so a later run's completion pops it again.
  const [completeDismissed, setCompleteDismissed] = useState(false);

  // A resume prepared in History lands here. Read the handoff from the live
  // store and clear it immediately: under StrictMode this effect fires twice,
  // and the second pass must find nothing or it starts a duplicate run. The run
  // goes into the store like any other, so leaving this step only stops
  // rendering it.
  useEffect(() => {
    const pending = useStore.getState().pendingResume;
    if (!pending || !s3Config) return;
    useStore.getState().setPendingResume(null);
    setResumeProblems(pending.problems);
    setCompleteDismissed(false);
    attachedRef.current = pending.attached;
    const generation = pending.generation;
    useStore.getState().setAttachedFiles(pending.attached);
    const run = resumeUpload(
      {
        config: s3Config,
        session: pending.session,
        attached: pending.attached,
        concurrency: concurrencyControl(),
      },
      (next) => setActiveSnap(next, generation),
    );
    setActiveRun(run, generation);
  }, [pendingResume, s3Config, setActiveRun, setActiveSnap]);



  const ready = useMemo(() => files.filter((f) => f.processState === 'ready' && f.sha256), [files]);
  const stillInspecting = files.length - ready.length;

  const start = () => {
    if (!s3Config || !location || !collection || !slug) return;
    setCompleteDismissed(false);
    attachedRef.current = null; // this batch's files are the store's again
    setResumeProblems([]);
    const generation = beginActiveRun();
    if (generation === null) return;
    const run = runStreamingUpload(
      {
        config: s3Config,
        dryRun: effectiveDryRun,
        concurrency: concurrencyControl(),
        uploaderUser,
        fileAccessMode,
        dirHandle,
        build: {
          location,
          collectionUuid: collection.uuid,
          bucket: collection.bucket,
          uploaderSlug: slug,
          description,
          timeZone: uploadTimeZone,
          files,
        },
      },
      (next) => setActiveSnap(next, generation),
    );
    setActiveRun(run, generation, run);
    // If inspection finished before Start was clicked, no later store update
    // will close the queue. The store owns the run; close it immediately here.
    useStore.getState().closeStreamingQueue(files);
  };

  // The hand-off record exists to get a batch to the tagger and its tags back;
  // once those tags are published it is dead weight holding paths, hashes,
  // thumbnails and possibly a live folder handle. Only a real publish clears it
  // — a dry run wrote nothing, and "Start over" is not the user saying they are
  // finished with the tags.
  useEffect(() => {
    if (!flipId || snap?.phase !== 'done' || snap.dryRun) return;
    void deleteFlipRecord(flipId);
  }, [flipId, snap?.phase, snap?.dryRun]);

  const retryPending = useRef(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryFailed = useCallback(async () => {
    // The async gap before resumeUpload's first emit leaves the Retry button
    // mounted — guard so a double-click can't start two concurrent runs.
    if (!snap || !s3Config || retryPending.current) return;
    const expectedConnectionId = connectionId;
    const connectionIsCurrent = () => {
      const state = useStore.getState();
      return !!state.s3Config && state.connectionId === expectedConnectionId;
    };
    retryPending.current = true;
    setRetryError(null);
    setCompleteDismissed(false);
    try {
      // Partial wet runs persist before uploading, so the ledger should be
      // present — but the load can still fail (cleared site data, IDB error),
      // and the guard must unlatch or Retry is dead until a reload.
      const session = await loadSession(snap.sessionId);
      if (!connectionIsCurrent()) return;
      if (!session) throw new Error('no saved record for this session');
      const attached = attachedRef.current ?? new Map(files.map((f) => [f.relPath, f.file]));

      // A run that hit the systemic-failure abort (e.g. many concurrent
      // blobs failing at once when the network drops) never reaches the
      // publish step, so it has no bundle — same gap History's Resume
      // fixes, resolved here from the files already in memory instead of a
      // disk re-hash pass, since they never left the page.
      if (!session.bundle) {
        const resolved = new Map<string, ProcessResponse>(
          files
            .filter((f) => f.processState === 'ready' && f.sha256)
            .map((f) => [
              f.relPath,
              {
                id: f.relPath,
                sha256: f.sha256,
                exifNaive: f.exifNaive,
                exifCamera: f.exifCamera,
                gps: f.gps,
                width: f.width,
                height: f.height,
                mediaKind: f.mediaKind,
                mimeType: f.mimeType,
              },
            ]),
        );
        const result = await ensureBundle(session.batch, session, resolved);
        if (!connectionIsCurrent()) return;
        if (!result.ok) {
          const reasons = result.problems.map((p) => `${p.fileName}: ${p.reason}`).slice(0, 3).join('; ');
          throw new Error(`${result.problems.length} file(s) couldn't be resolved (${reasons})`);
        }
      }

      const finalSession = session.bundle ? session : await loadSession(snap.sessionId);
      if (!connectionIsCurrent()) return;
      if (!finalSession) throw new Error('session record disappeared while resolving it');

      const config = useStore.getState().s3Config;
      if (!config || !connectionIsCurrent()) return;
      const generation = beginActiveRun();
      if (generation === null) return;
      const run = resumeUpload(
        {
          config,
          session: finalSession,
          attached,
          concurrency: concurrencyControl(),
        },
        (next) => setActiveSnap(next, generation),
      );
      setActiveRun(run, generation);
    } catch (e) {
      setRetryError(
        `Couldn't resume this upload (${e instanceof Error ? e.message : String(e)}). Retry again; if it keeps failing, go Back and start the upload over.`,
      );
    } finally {
      retryPending.current = false;
    }
  }, [snap, s3Config, connectionId, files, beginActiveRun, setActiveRun, setActiveSnap]);

  // A resumed run replays a persisted bundle and needs nothing from Assign, so
  // these guards stand down once a run is in flight or handed off.
  if ((!location || !collection || !slug) && !snap && !pendingResume) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Note
          tone="warn"
          message="Missing a deployment, target collection, or uploader identity. Go back to Assign."
        />
        <button
          onClick={() => setStep('assign')}
          className="border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover"
        >
          Back
        </button>
      </div>
    );
  }

  // Not an early return, unlike the checks above: a run may already be
  // active in the background (processing.ts keeps going regardless of the
  // screen), and swapping out the whole step would hide it. A file missing a
  // capture time only blocks the final publish (see the close-triggering
  // effect above) — fixed inline below, the same editor Assign uses, so
  // there's no need to leave this step for it.
  const needsCaptureTime = files.some((f) => f.processState === 'ready' && !f.exifNaive);

  return (
    <div className="max-w-2xl mx-auto space-y-7">
      <OfflineBanner message="You're offline — the dry run still works, but a real upload won't until your connection is back." />
      {/* Run configuration. A resume handed off from History replays a persisted
          bundle with no Assign state behind it, so the options collapse away. */}
      <section className="space-y-3">
        <h2 className={sectionLabel}>Upload</h2>
        {collection && (
          <>
            <p className="font-body text-[13px] text-inkSoft">
              {ready.length} file{ready.length === 1 ? '' : 's'} ready
              {stillInspecting > 0 && ` (${stillInspecting} still being inspected)`} ·{' '}
              {formatBytes(ready.reduce((n, f) => n + f.size, 0))} →{' '}
              <span className="font-mono text-ink break-all">
                {collection.bucket}/Collections/{collection.uuid}/Uploads/
              </span>
            </p>

            <label className="flex items-center gap-2.5 font-body text-[14px] text-ink">
              <input
                type="checkbox"
                checked={effectiveDryRun}
                disabled={anyRunActive}
                onChange={(e) => setDryRun(e.target.checked)}
                className="accent-accent"
              />
              Test the upload, nothing is written
            </label>

            {!effectiveDryRun && (
              <Note
                tone="warn"
                message={`If not testing the upload and it fails right away, that's usually a setup issue on the storage side, not something you did wrong. Contact your administrator and give them this collection ID: ${collection.uuid}.`}
              />
            )}
          </>
        )}

        {stillInspecting > 0 && (
          <Note
            tone="mute"
            message={`Still inspecting ${stillInspecting} file${stillInspecting === 1 ? '' : 's'} in the background — uploading proceeds as each one finishes; publishing waits until every file is done.`}
          />
        )}

        {/* Concurrency sits outside the config gate: a resume handed off from
            History has no Assign state behind it but still runs lanes. */}
        {(collection || snap || pendingResume) && (
          <div className="space-y-1.5">
            {concurrencyMode === 'adaptive' ? (
              <div className="flex items-center gap-3">
                <span className="font-body text-[13px] text-inkSoft w-28">Concurrency</span>
                <span className="flex items-center gap-2 font-mono text-[13px] text-ink">
                  adaptive
                  <AdaptiveInfo />
                  {running && snap?.lanes ? <span>· {snap.lanes} lanes</span> : null}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <label className="font-body text-[13px] text-inkSoft w-28">Concurrency</label>
                <input
                  type="range"
                  min={4}
                  max={32}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="flex-1 accent-accent"
                />
                <span className="font-mono text-[13px] text-ink w-8 text-right">{concurrency}</span>
              </div>
            )}
            {concurrencyMode === 'manual' && (
              <p className="font-body text-[12px] text-inkMute">
                Changes apply immediately, mid-run. Switch to adaptive tuning in Settings.
              </p>
            )}
          </div>
        )}
      </section>

      {resumeProblems.length > 0 && (
        <div className="border border-warn/40 bg-paper px-3 py-2.5 space-y-1">
          <p className="font-body text-[13px] text-warn">
            {resumeProblems.length} file{resumeProblems.length === 1 ? '' : 's'} could not be
            reconciled and will be skipped:
          </p>
          <ul className="font-mono text-[11px] text-inkSoft max-h-32 overflow-auto">
            {resumeProblems.slice(0, 50).map((p) => (
              <li key={p.localPath} className="truncate" title={`${p.localPath} — ${p.reason}`}>
                {p.fileName} — {p.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsCaptureTime && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Capture time</h2>
          <p className="font-body text-[13px] text-inkSoft">
            Publishing waits until every file below has a capture time.
          </p>
          <CaptureTimeEditor files={files} />
        </section>
      )}

      {/* Live run */}
      {snap && <RunMonitor snap={snap} />}

      {retryError && <Note tone="warn" message={retryError} />}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-ruleSoft pt-5">
        <button
          onClick={() => setStep('assign')}
          disabled={anyRunActive}
          className={`border border-ink text-ink px-3.5 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
            anyRunActive ? 'opacity-40 cursor-not-allowed' : ''
          }`}
        >
          Back
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <button
              onClick={() => activeRun?.cancel()}
              className="border border-warn text-warn px-3.5 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              Cancel
            </button>
          ) : anyRunActive ? (
            <button
              disabled
              className="bg-ink text-paper border border-ink px-3.5 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 text-[14px] font-body font-[600] opacity-40 cursor-not-allowed"
            >
              {effectiveDryRun ? 'Start dry run' : 'Start upload'}
            </button>
          ) : snap?.phase === 'done' && !snap.dryRun ? (
            <button
              onClick={() => {
                clearActiveRun();
                nextBatch();
              }}
              className="bg-ink text-paper border border-ink px-3.5 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 text-[14px] font-body font-[600] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              Next batch
            </button>
          ) : (snap?.phase === 'partial' || snap?.phase === 'error') && !snap.dryRun ? (
            <button
              onClick={retryFailed}
              title={!online ? "You're offline" : undefined}
              className="bg-ink text-paper border border-ink px-3.5 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 text-[14px] font-body font-[600] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              {snap.phase === 'error' ? 'Retry' : 'Retry failed files'}
            </button>
          ) : (
            <button
              onClick={start}
              title={!effectiveDryRun && !online ? "You're offline" : undefined}
              className="bg-ink text-paper border border-ink px-3.5 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 text-[14px] font-body font-[600] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              {effectiveDryRun ? 'Start dry run' : 'Start upload'}
            </button>
          )}
        </div>
      </div>

      {snap?.phase === 'done' && !snap.dryRun && !completeDismissed && (
        <UploadCompleteDialog
          doneCount={snap.files.filter((f) => f.state === 'done').length}
          collectionId={snap.collectionUuid}
          onClose={() => setCompleteDismissed(true)}
        />
      )}
    </div>
  );
}
