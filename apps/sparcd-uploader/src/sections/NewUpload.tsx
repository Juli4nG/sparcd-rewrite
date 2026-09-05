import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Severity } from '../lib/validation';
import { StepIndicator } from '../components/StepIndicator';
import { DropZone } from '../components/DropZone';
import { FileList } from '../components/FileList';
import { Assign } from './Assign';
import { Upload } from './Upload';
import { canPickFolder, formatBytes, supportsDirectoryHandle } from '../lib/scanFiles';
import { summarize } from '../lib/validation';
import { ensureProcessing } from '../lib/processing';
import { listResumable, fileStateCounts } from '../lib/db';
import { reselectFolder } from '../lib/resume';
import type { FlipRecord } from '@sparcd/flip';
import {
  adoptRecord,
  adoptReselected,
  handOffToTagger,
  reopenTagger,
  resumeFromFlip,
  returningFlipId,
  type FlipReturn,
} from '../lib/flip';


type OpenSession = { stamp: string; done: number; total: number; others: number };

// A reload lands on the empty Drop step, which gives no sign that an
// interrupted wet upload is still resumable in IndexedDB. Point at History,
// which owns the actual resume flow.
function ResumeNotice() {
  const setSection = useStore((s) => s.setSection);
  const [open, setOpen] = useState<OpenSession | null>(null);

  useEffect(() => {
    void (async () => {
      const [latest, ...others] = await listResumable();
      if (!latest) return;
      const counts = await fileStateCounts(latest.id);
      setOpen({
        stamp: latest.uploadPrefix.slice(latest.uploadPrefix.lastIndexOf('/') + 1),
        done: counts.done,
        total: latest.totalFiles,
        others: others.length,
      });
    })();
  }, []);

  if (!open) return null;

  return (
    <div className="mb-4 flex flex-col gap-2 border border-ruleSoft bg-paper px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="font-body text-[13px] text-inkSoft">
        An interrupted upload is waiting:{' '}
        <span className="font-mono text-ink">{open.stamp}</span> —{' '}
        <span className="font-mono text-ink">{open.done}</span> of{' '}
        <span className="font-mono text-ink">{open.total}</span> files uploaded.
        {open.others > 0 && ` (+${open.others} more in History)`}
      </p>
      <button
        type="button"
        onClick={() => setSection('history')}
        className="shrink-0 min-h-[44px] sm:min-h-0 border border-ink text-ink px-3 py-2.5 sm:py-1 text-[13px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        Open History
      </button>
    </div>
  );
}

export function NewUpload() {
  const step = useStore((s) => s.step);
  const files = useStore((s) => s.files);
  const validations = useStore((s) => s.validations);
  const batchToken = useStore((s) => s.batchToken);
  const flipId = useStore((s) => s.flipId);
  const resetBatch = useStore((s) => s.resetBatch);
  const setStep = useStore((s) => s.setStep);

  // Start (or adopt) processing whenever a fresh batch reaches the inspect step.
  // ensureProcessing is idempotent per batch token, so this is safe to re-run.
  useEffect(() => {
    if (step === 'inspect' && files.length > 0) ensureProcessing();
  }, [step, batchToken, files.length]);

  const flip = useFlipReturn();

  const totalBytes = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);
  const summary = useMemo(() => summarize(files, validations), [files, validations]);
  const tagged = useMemo(() => files.filter((f) => f.preTags?.length).length, [files]);

  // Clicking a severity counter filters the list to just those files —
  // scrolling a 5000-row list for the one flagged file is not an option.
  const [severityFilter, setSeverityFilter] = useState<Severity | null>(null);
  useEffect(() => {
    if (severityFilter === 'error' && summary.errors === 0) setSeverityFilter(null);
    if (severityFilter === 'warning' && summary.warnings === 0) setSeverityFilter(null);
  }, [severityFilter, summary.errors, summary.warnings]);

  const counterClass = (filter: Severity, tone: string) =>
    `font-mono ${tone} underline-offset-2 hover:underline ${
      severityFilter === filter ? 'underline' : ''
    }`;

  // Draw the eye to Continue the moment it becomes enabled, then settle down
  // — a permanent throb reads as nagging, not helpful. Re-triggers if it goes
  // back to disabled (e.g. a new error surfaces) and becomes ready again.
  const [throb, setThrob] = useState(false);
  useEffect(() => {
    if (!summary.ready) {
      setThrob(false);
      return;
    }
    setThrob(true);
    const timer = setTimeout(() => setThrob(false), 10_000);
    return () => clearTimeout(timer);
  }, [summary.ready]);

  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <StepIndicator current={step} />
      </div>

      {step === 'drop' &&
        (flip ? (
          <FlipReturnPanel state={flip} />
        ) : (
          <>
            <ResumeNotice />
            <DropZone />
          </>
        ))}

      {step === 'inspect' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-body text-[14px] text-inkSoft">
              <span className="font-mono text-ink">{files.length}</span> files ·{' '}
              <span className="font-mono text-ink">{formatBytes(totalBytes)}</span>
              {flipId && (
                <>
                  {' · '}
                  <span className="font-mono text-ink">{tagged}</span> tagged
                </>
              )}
              {summary.pending > 0 && (
                <>
                  {' · '}
                  <span className="font-mono text-inkSoft">{summary.pending}</span> processing
                </>
              )}
              {summary.errors > 0 && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setSeverityFilter((f) => (f === 'error' ? null : 'error'))}
                    aria-pressed={severityFilter === 'error'}
                    title={severityFilter === 'error' ? 'Show all files' : 'Show only files needing attention'}
                    className={counterClass('error', 'text-warn')}
                  >
                    {summary.errors} need attention
                  </button>
                </>
              )}
              {summary.warnings > 0 && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setSeverityFilter((f) => (f === 'warning' ? null : 'warning'))}
                    aria-pressed={severityFilter === 'warning'}
                    title={severityFilter === 'warning' ? 'Show all files' : 'Show only warnings'}
                    className={counterClass('warning', 'text-warn')}
                  >
                    {summary.warnings} warnings
                  </button>
                </>
              )}
              {summary.noCameraTime > 0 && (
                <>
                  {' · '}
                  <span className="font-mono text-warn">
                    {summary.noCameraTime} without camera time
                  </span>
                </>
              )}
              {severityFilter && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setSeverityFilter(null)}
                    className="font-body text-[12px] text-inkSoft underline underline-offset-2"
                  >
                    clear filter
                  </button>
                </>
              )}
            </p>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={resetBatch}
                className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0 border border-ink text-ink px-3.5 py-2.5 sm:py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                Start over
              </button>
              <button
                disabled={!summary.ready}
                onClick={() => (flipId ? reopenTagger(flipId) : void handOffToTagger())}
                title={
                  flipId
                    ? 'Go back to the tagger and pick up where you left off'
                    : summary.ready
                      ? 'Identify species in the Tagger before uploading'
                      : 'Resolve files that need attention first'
                }
                className={`flex-1 sm:flex-none min-h-[44px] sm:min-h-0 bg-mark text-ink border border-ink px-3.5 py-2.5 sm:py-1.5 text-[14px] font-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                  summary.ready ? 'hover:bg-paperHover' : 'opacity-40 cursor-not-allowed'
                }`}
              >
                {flipId ? 'Edit tags' : 'Tag species first'}
              </button>
              <button
                disabled={!summary.ready}
                onClick={() => setStep('assign')}
                title={summary.ready ? 'Continue to assignment' : 'Resolve files that need attention first'}
                className={`flex-1 sm:flex-none min-h-[44px] sm:min-h-0 bg-ink text-paper border border-ink px-3.5 py-2.5 sm:py-1.5 text-[14px] font-body font-[600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                  summary.ready
                    ? `hover:opacity-90 hover:animate-none ${throb ? 'animate-throb' : ''}`
                    : 'opacity-40 cursor-not-allowed'
                }`}
              >
                Continue
              </button>
            </div>
          </div>
          <FileList severityFilter={severityFilter} />
          <p className="font-body text-[13px] text-inkMute">
            Press <span className="font-mono">D</span> to drop a flagged duplicate — it's kept
            otherwise.
            {summary.noCameraTime > 0 && (
              <>
                {' '}
                A time tagged <span className="font-mono">EST.</span> was estimated — review it in
                Assign.
              </>
            )}
          </p>
        </div>
      )}

      {step === 'assign' && <Assign />}

      {step === 'upload' && <Upload />}
    </div>
  );
}

/**
 * Pick the batch back up when the tagger sends the user here with `?flip=<id>`.
 * A page load is not a user gesture, so the restore can legitimately stop and
 * ask for a click — see `resumeFromFlip`. Returns null once the batch is in the
 * store (or when this was an ordinary visit), so the drop zone shows as usual.
 */
function useFlipReturn(): FlipPending | null {
  const [state, setState] = useState<FlipPending | null>(null);

  useEffect(() => {
    const id = returningFlipId();
    if (!id) return;
    void resumeFromFlip(id).then((r) => setState(r.kind === 'restored' ? null : r));
  }, []);

  return state;
}

/** Everything that still needs the user before the batch is back on screen. */
type FlipPending = Exclude<FlipReturn, { kind: 'restored' }>;

function FlipReturnPanel({ state }: { state: FlipPending }) {
  if (state.kind === 'not-found') {
    return (
      <Panel title="That batch isn't here">
        <p>
          The tagger pointed back at a batch this browser has no record of. It may have been
          cleared, or the two tools may be running on different origins — in development they are.
          Choose the folder again to start over.
        </p>
      </Panel>
    );
  }
  if (state.kind === 'needs-reselect') return <ReselectPanel record={state.record} />;
  return <ReopenPanel record={state.record} />;
}

/**
 * No durable handle rode along with the batch, so the folder has to be pointed
 * at again. Same three-way choice the drop zone makes: the File System Access
 * picker where it exists (it hands back a handle for next time), the rendered
 * `webkitdirectory` input on a desktop browser without it, and individual files
 * on a device that cannot present a folder picker at all.
 */
function ReselectPanel({ record }: { record: FlipRecord }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderPick = canPickFolder();

  async function adopt(list?: FileList) {
    setBusy(true);
    try {
      const picked = await reselectFolder(list);
      if (picked) adoptReselected(record, picked.scanned);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Choose the folder again">
      <p>
        Your tags are safe. This browser doesn't keep a durable handle on the folder, so it needs
        you to point at <span className="font-mono text-ink">{record.files.length}</span> files
        once more before they can be uploaded.
      </p>
      <PanelButton
        busy={busy}
        label={folderPick ? 'Choose folder' : 'Choose photos or videos'}
        onClick={() => {
          if (supportsDirectoryHandle) void adopt();
          else inputRef.current?.click();
        }}
      />
      {folderPick ? (
        <input
          ref={inputRef}
          type="file"
          // @ts-expect-error — non-standard but widely supported folder picker
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={onPick}
        />
      ) : (
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,video/mp4"
          multiple
          hidden
          onChange={onPick}
        />
      )}
    </Panel>
  );

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (list?.length) void adopt(list);
    e.target.value = '';
  }
}

function ReopenPanel({ record }: { record: FlipRecord }) {
  const [busy, setBusy] = useState(false);
  return (
    <Panel title="Reopen the batch">
      <p>
        Your tags are safe. The browser wants a click before it hands the folder's{' '}
        <span className="font-mono text-ink">{record.files.length}</span> files back — reading them
        from a page load alone isn't allowed.
      </p>
      <PanelButton
        busy={busy}
        label="Reopen batch"
        onClick={async () => {
          setBusy(true);
          // Straight into adoptRecord: the permission request has to be the
          // first thing this click awaits, or Safari and Firefox drop it.
          await adoptRecord(record);
          setBusy(false);
        }}
      />
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-rule bg-panel px-6 py-8 max-w-[640px] space-y-4">
      <h2 className="font-display text-[20px] font-[600] text-ink">{title}</h2>
      <div className="font-body text-[14px] text-inkSoft space-y-4">{children}</div>
    </div>
  );
}

function PanelButton({
  busy,
  label,
  onClick,
}: {
  busy: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="min-h-[44px] sm:min-h-0 bg-ink text-paper border border-ink px-3.5 py-2.5 sm:py-1.5 text-[14px] font-body font-[600] hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
    >
      {busy ? 'Working…' : label}
    </button>
  );
}
