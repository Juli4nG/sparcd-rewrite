// Past and in-flight upload sessions, read from the Dexie resume store (P5).
// Completed batches are a record; open batches (no completedAt) offer Resume —
// which restores local file access (durable handle or reselect-and-reconcile)
// and then hands the prepared session to the wizard's Upload step, which owns
// the run UI. Discard drops the local session row only; it never touches remote
// state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { OfflineBanner, useOnline } from '@sparcd/auth-ui';
import { useStore } from '../store';
import { formatBytes } from '../lib/scanFiles';
import {
  listBatches,
  loadSession,
  discardSession,
  fileStateCounts,
  updateBatch,
  type BatchRecord,
  type LoadedSession,
  type PersistedFileState,
} from '../lib/db';
import {
  restoreFromHandle,
  reconcileReselect,
  reselectFolder,
  ensureBundle,
  type ReconcileProblem,
} from '../lib/resume';
import { scanFileList, supportsDirectoryHandle } from '../lib/scanFiles';
import type { ProcessResponse } from '../lib/processPool';
import { Note } from '../components/RunMonitor';
import { PublishedUploads } from '../components/PublishedUploads';

type Row = { batch: BatchRecord; counts: Record<PersistedFileState, number> };

const stampOf = (prefix: string) => prefix.slice(prefix.lastIndexOf('/') + 1);

function ownsPreparation(sessionId: string, connectionId: number, generation: number): boolean {
  const state = useStore.getState();
  return !!state.s3Config &&
    state.connectionId === connectionId &&
    state.activeRunGeneration === generation &&
    state.activeRunReserved &&
    state.historyResumePreparation?.sessionId === sessionId;
}

function Badge({ batch }: { batch: BatchRecord }) {
  const done = !!batch.completedAt;
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-[0.12em] px-1.5 py-0.5 border ${
        done ? 'border-ok/50 text-ok' : 'border-warn/50 text-warn'
      }`}
    >
      {done ? 'complete' : 'open'}
    </span>
  );
}

export function History() {
  const s3Config = useStore((s) => s.s3Config);
  const setPendingResume = useStore((s) => s.setPendingResume);
  const setSection = useStore((s) => s.setSection);
  const setStep = useStore((s) => s.setStep);
  // Upload owns fresh and resumed runs. History only needs the live session id
  // to keep that session's local ledger protected while the run is active.
  const activeSessionId = useStore((s) =>
    s.activeSnap &&
    (s.activeSnap.phase === 'preparing' ||
      s.activeSnap.phase === 'blobs' ||
      s.activeSnap.phase === 'metadata')
      ? s.activeSnap.sessionId
      : null,
  );
  const activeRunReserved = useStore((s) => s.activeRunReserved);
  const beginActiveRun = useStore((s) => s.beginActiveRun);
  const clearActiveRun = useStore((s) => s.clearActiveRun);
  const preparation = useStore((s) => s.historyResumePreparation);
  const beginPreparation = useStore((s) => s.beginHistoryResumePreparation);
  const setPreparationProgress = useStore((s) => s.setHistoryResumeProgress);
  const clearPreparation = useStore((s) => s.clearHistoryResumePreparation);

  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReconcileProblem[]>([]);
  // True while the fallback <input> picker is open. Separate from the shared
  // preparation lock because a cancelled native picker may fire no change event.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerOpenRef = useRef(false);
  const pickerCleanupRef = useRef<(() => void) | null>(null);
  const reselectRef = useRef<HTMLInputElement>(null);
  const pendingReselect = useRef<BatchRecord | null>(null);

  const refresh = useCallback(async () => {
    const batches = await listBatches();
    const withCounts = await Promise.all(
      batches.map(async (batch) => ({ batch, counts: await fileStateCounts(batch.id) })),
    );
    setRows(withCounts);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closePicker = useCallback(() => {
    pickerOpenRef.current = false;
    pickerCleanupRef.current?.();
    pickerCleanupRef.current = null;
    setPickerOpen(false);
  }, []);

  // A picker normally restores focus, but remove any native listeners if
  // History unmounts first.
  useEffect(() => {
    return () => pickerCleanupRef.current?.();
  }, []);

  const running = activeSessionId !== null;
  const online = useOnline();

  const launch = useCallback(
    (
      session: LoadedSession,
      attached: Map<string, File>,
      probs: ReconcileProblem[],
      expectedConnectionId: number,
      generation: number,
    ) => {
      if (!ownsPreparation(session.batch.id, expectedConnectionId, generation)) return;
      const missingRequired = session.files.filter((f) => f.state !== 'done' && !attached.has(f.localPath));
      if (missingRequired.length > 0) {
        setProblems([
          ...probs,
          ...missingRequired.map((f) => ({
            localPath: f.localPath,
            fileName: f.fileName,
            reason: 'required for resume but not reattached',
          })),
        ]);
        setMessage(
          `${missingRequired.length} pending or failed source file${
            missingRequired.length === 1 ? '' : 's'
          } could not be reattached. Reselect the original folder before resuming.`,
        );
        return;
      }
      setProblems([]);
      setMessage(null);
      if (!ownsPreparation(session.batch.id, expectedConnectionId, generation)) return;
      setPendingResume({ session, attached, problems: probs, generation });
      clearPreparation(session.batch.id);
      setSection('new');
      setStep('upload');
    },
    [clearPreparation, setPendingResume, setSection, setStep],
  );

  // If this session was interrupted before it ever reached publish
  // (`session.bundle` is null), resolve any still-unprocessed files and
  // attach the bundle it never got, before proceeding exactly as a normal
  // resume would. `ensureBundle` is a no-op once a bundle already exists.
  const launchWithBundle = useCallback(
    async (
      batch: BatchRecord,
      session: LoadedSession,
      attached: Map<string, File>,
      probs: ReconcileProblem[],
      resolved: Map<string, ProcessResponse>,
      expectedConnectionId: number,
      generation: number,
    ) => {
      if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
      const result = await ensureBundle(batch, session, resolved);
      if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
      if (!result.ok) {
        setProblems([...probs, ...result.problems]);
        setMessage(
          `${result.problems.length} file${result.problems.length === 1 ? '' : 's'} couldn't be resolved to resume this upload.`,
        );
        return;
      }
      const finalSession = session.bundle ? session : await loadSession(batch.id);
      if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
      if (!finalSession) {
        setMessage('Session record is missing.');
        return;
      }
      launch(finalSession, attached, probs, expectedConnectionId, generation);
    },
    [launch],
  );

  const beginResume = useCallback(
    async (batch: BatchRecord) => {
      setProblems([]);
      const expectedConnectionId = useStore.getState().connectionId;
      const generation = beginActiveRun();
      if (generation === null) {
        setMessage('Another upload is already active. Finish or cancel it before resuming this batch.');
        return;
      }
      beginPreparation(batch.id);
      try {
        if (!s3Config) {
          setMessage('Connect to a storage endpoint before resuming.');
          return;
        }
        // The first await below must be the actual gated call — permission
        // request, directory picker, or the hidden <input>'s `.click()` —
        // not this session load. Firefox/Safari require those to fire within
        // the click's transient user-activation window; an unrelated await
        // ahead of them (even a fast IndexedDB read) silently breaks it: no
        // prompt, no error, nothing happens. Kick the load off in parallel
        // instead and only consume it once the gated step has resolved.
        const sessionPromise = loadSession(batch.id);
        const onProgress = (done: number, total: number) =>
          setPreparationProgress(batch.id, done, total);

        // Durable handle: revalidate permission inside this click gesture, then
        // re-hash against the recorded files — a same-size in-place edit between
        // sessions would otherwise slip through, so mismatches surface as problems.
        if (batch.fileAccessMode === 'persistent-handle' && batch.dirHandle) {
          const restore = await restoreFromHandle(
            batch,
            sessionPromise.then((s) => s?.files ?? []),
            onProgress,
          );
          if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
          const session = await sessionPromise;
          if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
          if (!session) {
            setMessage('Session record is missing.');
            return;
          }
          if (restore.ok) {
            await launchWithBundle(
              batch,
              session,
              restore.attached,
              restore.problems,
              restore.resolved,
              expectedConnectionId,
              generation,
            );
            return;
          }
          setMessage(restore.reason);
          // fall through to reselect
        }

        // Reselect path.
        if (supportsDirectoryHandle) {
          const picked = await reselectFolder();
          if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
          if (!picked) return; // user dismissed
          const session = await sessionPromise;
          if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
          if (!session) {
            setMessage('Session record is missing.');
            return;
          }
          const { attached, problems: probs, resolved } = await reconcileReselect(session.files, picked.scanned, onProgress);
          if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
          // Opportunistically upgrade the session to a durable handle for next time.
          if (picked.handle) {
            await updateBatch(batch.id, { dirHandle: picked.handle, fileAccessMode: 'persistent-handle' });
            if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
          }
          await launchWithBundle(batch, session, attached, probs, resolved, expectedConnectionId, generation);
        } else {
          // No durable picker — fall back to a transient <input webkitdirectory>.
          // Release the lock before clicking: on Firefox/Safari a cancelled picker
          // fires no change event, so onReselectInput never runs. onReselectInput
          // re-acquires the lock itself when files actually arrive.
          clearPreparation(batch.id);
          clearActiveRun();
          pickerOpenRef.current = true;
          setPickerOpen(true);
          pendingReselect.current = batch;
          const input = reselectRef.current;
          if (!input) {
            closePicker();
            return;
          }
          // Attach before the synchronous native picker call. Older Safari and
          // Firefox can restore focus before this handler returns and never emit
          // `cancel`, so a post-render effect is too late to observe dismissal.
          const onCancel = () => closePicker();
          const onFocus = () => {
            if (pickerOpenRef.current && !input.files?.length) closePicker();
          };
          input.addEventListener('cancel', onCancel);
          window.addEventListener('focus', onFocus);
          pickerCleanupRef.current = () => {
            input.removeEventListener('cancel', onCancel);
            window.removeEventListener('focus', onFocus);
          };
          input.click();
        }
      } finally {
        clearPreparation(batch.id);
        const state = useStore.getState();
        if (
          state.activeRunGeneration === generation &&
          state.activeRunReserved &&
          !state.activeRun &&
          state.pendingResume?.generation !== generation
        ) {
          clearActiveRun();
        }
      }
    },
    [s3Config, launchWithBundle, beginActiveRun, beginPreparation, setPreparationProgress, clearPreparation, clearActiveRun, closePicker],
  );

  const onReselectInput = useCallback(
    async (list: File[] | null) => {
      closePicker();
      const batch = pendingReselect.current;
      pendingReselect.current = null;
      if (!batch || !list || list.length === 0) return;
      const expectedConnectionId = useStore.getState().connectionId;
      const generation = beginActiveRun();
      if (generation === null) {
        setMessage('Another upload is already active. Finish or cancel it before resuming this batch.');
        return;
      }
      beginPreparation(batch.id);
      try {
        const session = await loadSession(batch.id);
        if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
        if (!session) {
          setMessage('Session record is missing.');
          return;
        }
        const { attached, problems: probs, resolved } = await reconcileReselect(session.files, scanFileList(list), (done, total) =>
          setPreparationProgress(batch.id, done, total),
        );
        if (!ownsPreparation(batch.id, expectedConnectionId, generation)) return;
        await launchWithBundle(batch, session, attached, probs, resolved, expectedConnectionId, generation);
      } finally {
        clearPreparation(batch.id);
        const state = useStore.getState();
        if (
          state.activeRunGeneration === generation &&
          state.activeRunReserved &&
          !state.activeRun &&
          state.pendingResume?.generation !== generation
        ) {
          clearActiveRun();
        }
      }
    },
    [launchWithBundle, beginActiveRun, beginPreparation, setPreparationProgress, clearPreparation, clearActiveRun, closePicker],
  );

  const discard = useCallback(
    async (sessionId: string) => {
      const state = useStore.getState();
      const matchingSnap = state.activeSnap?.sessionId === sessionId ? state.activeSnap : null;
      const matchingRunIsLive =
        matchingSnap?.phase === 'preparing' ||
        matchingSnap?.phase === 'blobs' ||
        matchingSnap?.phase === 'metadata';
      const preparationIsLive = state.historyResumePreparation?.sessionId === sessionId;
      // The button is disabled for both cases, but enforce the invariant here
      // too so a stale render or programmatic click can never delete a live ledger.
      if (matchingRunIsLive || preparationIsLive) return;
      await discardSession(sessionId);
      await refresh();
    },
    [refresh],
  );

  if (rows === null) {
    return (
      <div className="px-6 py-6 max-w-2xl mx-auto">
        <p className="font-body text-[14px] text-inkSoft">Loading sessions…</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-6 py-6 max-w-2xl mx-auto space-y-8">
        <div className="border border-ruleSoft bg-panel px-6 py-12 text-center">
          <p className="font-display text-[18px] text-ink mb-1">No uploads yet</p>
          <p className="font-body text-[14px] text-inkSoft">
            Normal uploads are tracked here for resume — date, collection, deployment, file count, and
            status. Dry runs write nothing, so they are not recorded.
          </p>
        </div>
        <PublishedUploads />
      </div>
    );
  }

  return (
    <div className="px-6 py-6 max-w-2xl mx-auto space-y-5">
      <OfflineBanner message="You're offline — Resume won't work until your connection is back." />
      <input
        ref={reselectRef}
        type="file"
        // @ts-expect-error — non-standard folder picker, widely supported
        webkitdirectory=""
        directory=""
        multiple
        hidden
        onChange={(e) => {
          // Snapshot before clearing: FileList is live, and `onReselectInput`
          // is async — its first `await` (loadSession) yields back here
          // before it touches the list, so clearing `.value` synchronously
          // right after would empty the same FileList out from under it,
          // making every file look missing. Array.from freezes it first.
          void onReselectInput(e.target.files ? Array.from(e.target.files) : null);
          e.target.value = '';
        }}
      />

      {message && <Note tone="warn" message={message} />}

      {problems.length > 0 && (
        <div className="border border-warn/40 bg-paper px-3 py-2.5 space-y-1">
          <p className="font-body text-[13px] text-warn">
            {problems.length} file{problems.length === 1 ? '' : 's'} could not be reconciled:
          </p>
          <ul className="font-mono text-[11px] text-inkSoft max-h-32 overflow-auto">
            {problems.slice(0, 50).map((p) => (
              <li key={p.localPath} className="truncate" title={`${p.localPath} — ${p.reason}`}>
                {p.fileName} — {p.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="space-y-3">
        {rows.map(({ batch, counts }) => {
          const isActive = activeSessionId === batch.id;
          const isPreparing = preparation?.sessionId === batch.id;
          const verifyProgress = isPreparing ? preparation.progress : null;
          const total = batch.totalFiles;
          return (
            <li key={batch.id} className="border border-ruleSoft bg-panel px-4 py-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[13px] text-ink truncate" title={batch.uploadPrefix}>
                    {stampOf(batch.uploadPrefix)}
                  </p>
                  <p className="font-body text-[12px] text-inkSoft truncate">
                    {batch.targetBucket} · {new Date(batch.startedAt).toLocaleString()}
                  </p>
                </div>
                <Badge batch={batch} />
              </div>

              <p className="font-body text-[12px] text-inkSoft">
                <span className="font-mono text-ink">{total}</span> files ·{' '}
                <span className="font-mono text-ink">{formatBytes(batch.totalBytes)}</span> ·{' '}
                <span className="font-mono text-ok">{counts.done}</span> done
                {counts.failed > 0 && (
                  <>
                    {' · '}
                    <span className="font-mono text-warn">{counts.failed}</span> failed
                  </>
                )}
              </p>

              {isPreparing && verifyProgress && (
                <p className="font-body text-[12px] text-inkSoft">
                  Verifying <span className="font-mono text-ink">{verifyProgress.done}</span> of{' '}
                  <span className="font-mono text-ink">{verifyProgress.total}</span> files against
                  the original folder…
                </p>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                {!batch.completedAt && (
                  <button
                    disabled={activeRunReserved || preparation !== null || pickerOpen}
                    title={!online ? "You're offline" : undefined}
                    onClick={() => void beginResume(batch)}
                    className={`bg-ink text-paper border border-ink min-h-[44px] sm:min-h-0 px-4 sm:px-3 py-1 text-[13px] font-body font-[600] hover:opacity-90 ${
                      activeRunReserved || preparation !== null || pickerOpen ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                  >
                    {isPreparing ? 'Verifying…' : 'Resume'}
                  </button>
                )}
                <button
                  disabled={(running && isActive) || isPreparing}
                  onClick={() => void discard(batch.id)}
                  className="border border-ink text-ink min-h-[44px] sm:min-h-0 px-4 sm:px-3 py-1 text-[13px] font-body hover:bg-paperHover"
                >
                  Discard
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="pt-3 border-t border-ruleSoft">
        <PublishedUploads />
      </div>
    </div>
  );
}
