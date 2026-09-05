import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore, type FileEntry } from '../store';
import { formatNaive, naiveToInputValue, inputValueToNaive, type NaiveDateTime } from '../lib/exifTime';
import { naiveFromMillis, naiveMillis, naturalPathCompare } from '../lib/estimateCaptureTime';
import { spreadCaptureTimes, type SpreadOptions } from '../lib/spreadCaptureTimes';
import {
  useCaptureEstimates,
  effectiveTime,
  methodLine,
  sourceTag,
  spreadStartOf,
} from '../lib/useCaptureEstimates';

// Review surface for files the camera gave no capture time. Every one of them
// already HAS a time — the interpolation rule ran the moment the batch was
// examined — so nothing here is required: the rail picks a scope, the two tabs
// are the automatic rule and the manual override, and the grid is where a
// single straggler gets corrected. Upload is never blocked on any of it.

const sectionLabel = 'font-[600] text-[10px] tracking-[0.16em] uppercase text-inkSoft';
const inputClass =
  'border border-rule bg-paper px-2 py-1.5 font-mono text-[12px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1';
const buttonClass =
  'border border-ink text-ink px-3 py-1.5 text-[13px] font-body hover:bg-paperHover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2';

/** Grouping key for the rail: the file's own folder, batch root for a bare name. */
function folderOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut === -1 ? '(batch root)' : `${relPath.slice(0, cut)}/`;
}

const shortNaive = (n: NaiveDateTime): string => formatNaive(n).replace('T', ' ');
const minuteOf = (n: NaiveDateTime): string => shortNaive(n).slice(0, 16);

/** "2026-07-01 09:00:15 → 09:01:15" — the date printed once when both share it. */
const rangeText = (from: NaiveDateTime, to: NaiveDateTime): string => {
  const a = shortNaive(from);
  const b = shortNaive(to);
  return `${a} → ${a.slice(0, 10) === b.slice(0, 10) ? b.slice(11) : b}`;
};

const STRIP_COLUMNS = 240;

/** One tick per occupied column of the strip, opacity carrying how many
 *  timestamps fell into it. */
function bucketTicks(
  values: number[],
  pctOf: (ms: number) => number,
): { pct: number; opacity: number }[] {
  const counts = new Map<number, number>();
  for (const ms of values) {
    const column = Math.min(STRIP_COLUMNS, Math.max(0, Math.round((pctOf(ms) / 100) * STRIP_COLUMNS)));
    counts.set(column, (counts.get(column) ?? 0) + 1);
  }
  const busiest = Math.max(1, ...counts.values());
  return [...counts].map(([column, n]) => ({
    pct: (column / STRIP_COLUMNS) * 100,
    opacity: 0.35 + 0.65 * (n / busiest),
  }));
}

/**
 * The spread the two sequence fields describe, or nothing while either is
 * incomplete. An emptied start is not "the earliest selected file" and an
 * emptied spacing is not zero seconds, so neither may be quietly substituted:
 * Apply stays disabled and the summary line stays blank until both parse.
 */
export function sequenceSpread(startText: string, spacingText: string): SpreadOptions | undefined {
  const start = inputValueToNaive(startText);
  const spacingSeconds = Number(spacingText);
  return start && spacingSeconds > 0 ? { kind: 'sequence', start, spacingSeconds } : undefined;
}

function Thumb({ blob }: { blob?: Blob }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return (
    <span className="relative block w-24 h-16 bg-paperHover border border-ruleSoft overflow-hidden">
      {url && <img src={url} alt="" className="w-full h-full object-cover" />}
      <span className="absolute inset-x-0 bottom-0 text-center font-mono text-[8px] leading-[1.7] text-inkMute bg-ink/[0.07]">
        ----/--/-- --:--:--
      </span>
    </span>
  );
}

export function CaptureTimeEditor({ files }: { files: FileEntry[] }) {
  const setManualNaive = useStore((s) => s.setManualNaive);
  const setManualNaiveMany = useStore((s) => s.setManualNaiveMany);
  const uploadTimeZone = useStore((s) => s.uploadTimeZone);
  const estimates = useCaptureEstimates();

  const [scope, setScope] = useState<string | null>(null); // null = every file without a camera time
  const [tab, setTab] = useState<'interpolate' | 'spread'>('interpolate');
  const [startText, setStartText] = useState('');
  const [spacing, setSpacing] = useState('30');
  const [useModified, setUseModified] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const onRailKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const radios = [...(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    const next = radios[(at + (e.key === 'ArrowDown' ? 1 : radios.length - 1)) % radios.length];
    next?.focus();
    next?.click();
  };

  const ready = files.filter((f) => f.processState === 'ready');
  const missing = ready.filter((f) => !f.exifNaive);
  const timed = ready.filter((f) => f.exifNaive);
  const spreadStart = spreadStartOf(files);

  const folderCounts = new Map<string, number>();
  for (const f of missing) {
    const key = folderOf(f.relPath);
    folderCounts.set(key, (folderCounts.get(key) ?? 0) + 1);
  }
  const folders = [...folderCounts.entries()].sort((a, b) => naturalPathCompare(a[0], b[0]));

  const selected = (scope === null ? missing : missing.filter((f) => folderOf(f.relPath) === scope))
    .slice()
    .sort((a, b) => naturalPathCompare(a.relPath, b.relPath));
  const gapsFilled = selected.filter((f) => !f.manualNaive).length;

  // Spread preview — recomputed live, applied only on the button. The start
  // field is seeded from the selection's earliest time and then owned by the
  // user; re-seeding on a scope change is the only thing that overwrites it.
  let earliest: NaiveDateTime | undefined;
  for (const f of selected) {
    const { naive } = effectiveTime(f, estimates);
    if (naive && (!earliest || naiveMillis(naive) < naiveMillis(earliest))) earliest = naive;
  }
  const earliestValue = earliest ? naiveToInputValue(earliest) : '';
  useEffect(() => setStartText(earliestValue), [earliestValue]);
  if (missing.length === 0) return null;

  const spreadOptions: SpreadOptions | undefined = useModified
    ? { kind: 'file-modified', timeZone: uploadTimeZone }
    : sequenceSpread(startText, spacing);
  const spread = spreadOptions ? spreadCaptureTimes(selected, spreadOptions) : undefined;
  const spreadFirst = spread && selected.length ? spread.get(selected[0].id) : undefined;
  const spreadLast = spread && selected.length ? spread.get(selected[selected.length - 1].id) : undefined;

  const applySpread = () => {
    if (!spread) return;
    setManualNaiveMany(
      [...spread].map(([id, naive]) => ({ id, naive })),
      'spread',
    );
  };

  // The strip is scaled to the camera times and nothing else. A single time
  // months away — a file-modified fallback, or one typed in wrong — would
  // otherwise stretch the bar until every camera tick piled into one column, so
  // anything past an end is drawn clamped to that end instead. An offset sits
  // ten minutes past the last camera time by design and the note below already
  // says so; every other kind of outside time is worth counting.
  let cameraMin = Infinity;
  let cameraMax = -Infinity;
  for (const f of timed) {
    const ms = naiveMillis(f.exifNaive!);
    if (ms < cameraMin) cameraMin = ms;
    if (ms > cameraMax) cameraMax = ms;
  }
  const estimateMs: number[] = [];
  let outside = 0;
  for (const f of missing) {
    const { naive, source } = effectiveTime(f, estimates);
    if (!naive) continue;
    const ms = naiveMillis(naive);
    estimateMs.push(ms);
    if (source !== 'offset' && (ms < cameraMin || ms > cameraMax)) outside++;
  }
  const span = cameraMax - cameraMin;
  const pctOf = (ms: number): number => (span > 0 ? ((ms - cameraMin) / span) * 100 : 0);
  // Thousands of ticks would paint a solid bar, so each kind collapses into
  // fixed columns and carries its density in the opacity instead.
  const cameraTicks = bucketTicks(timed.map((f) => naiveMillis(f.exifNaive!)), pctOf);
  const estimateTicks = bucketTicks(estimateMs, pctOf);

  const shown = showAll ? selected : selected.slice(0, 24);

  return (
    <div className="space-y-3">
      <p className="font-body text-[13px] text-inkSoft">
        <span className="font-mono text-ink">{files.length}</span> files ·{' '}
        <span className="inline-block border border-warn/50 text-warn font-mono text-[11px] px-1.5">
          {missing.length} without camera time
        </span>
      </p>

      <div className="border border-ruleSoft text-inkSoft bg-paper px-3 py-2.5 font-body text-[12.5px] leading-relaxed">
        {timed.length === 0
          ? `No file in this batch has a camera capture time. File modified times were used for all ${missing.length} files, and the upload will be marked as having a known timestamp issue. Use Spread if the file dates are wrong too.`
          : `${missing.length} files have no camera capture time. Times were estimated from neighbouring files, and this upload will be marked as having a known timestamp issue.`}
      </div>

      <div className="border border-ruleSoft bg-paper grid grid-cols-1 sm:grid-cols-[170px_minmax(0,1fr)]">
        <div className="border-b sm:border-b-0 sm:border-r border-ruleSoft px-2.5 py-3 min-w-0">
          <p className={`${sectionLabel} mb-2`}>Apply to</p>
          <div
            ref={railRef}
            role="radiogroup"
            aria-label="Files to apply to"
            onKeyDown={onRailKey}
          >
            {[
              [null, 'All estimated', missing.length] as const,
              // One folder means the folder row would just restate "All estimated".
              ...(folders.length > 1 ? folders.map(([name, n]) => [name, name, n] as const) : []),
            ].map(([key, label, n]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={scope === key}
                tabIndex={scope === key ? 0 : -1}
                onClick={() => setScope(key)}
                className={`w-full flex justify-between items-baseline gap-2 text-left font-body text-[12.5px] px-1.5 py-1.5 min-h-11 sm:min-h-0 border-l-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  scope === key
                    ? 'bg-paperHover border-ink text-ink'
                    : 'border-transparent text-inkSoft hover:bg-paperHover'
                }`}
              >
                <span className="truncate" title={label}>
                  {label}
                </span>
                <span className="font-mono text-[11.5px] text-inkMute">{n}</span>
              </button>
            ))}
          </div>
          <p className="w-full flex justify-between items-baseline gap-2 font-body text-[12.5px] text-inkMute px-1.5 py-1.5 mb-2.5 border-l-2 border-transparent">
            Has camera time
            <span className="font-mono text-[11.5px]">{timed.length}</span>
          </p>
          <p className="font-body text-[11px] leading-snug text-inkMute">
            Selection is by folder or by failure, never image-by-image. Click a thumbnail to
            override a straggler.
          </p>
        </div>

        <div className="px-3 pb-3 min-w-0">
          <div
            role="tablist"
            aria-label="Capture time operation"
            className="flex flex-wrap items-baseline gap-x-5 border-b border-ruleSoft -mb-px"
          >
            {(
              [
                ['interpolate', 'Interpolate'],
                ['spread', 'Spread from a start time'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`capture-time-tab-${key}`}
                aria-selected={tab === key}
                aria-controls="capture-time-panel"
                onClick={() => setTab(key)}
                className={`font-body text-[13px] pt-2.5 pb-2 -mb-px min-h-[44px] sm:min-h-0 border-b-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  tab === key
                    ? 'border-ink text-ink font-[600]'
                    : 'border-transparent text-inkSoft hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
            <span className="sm:ml-auto font-body text-[11px] leading-snug text-inkMute max-w-[34ch] py-2">
              Wrong-but-present times (reset clock): fix in the tagger's time shift.
            </span>
          </div>

          <div
            role="tabpanel"
            id="capture-time-panel"
            aria-labelledby={`capture-time-tab-${tab}`}
          >
            {tab === 'interpolate' ? (
              <>
                <p className="font-body text-[13px] leading-normal text-inkSoft mt-3 mb-2">
                  {timed.length === 0
                    ? 'No file in this batch has a camera time, so file modified times are used.'
                    : 'Filled from timestamped neighbours in filename order. 10 minutes past the first or last file. File modified time when no neighbour exists.'}
                </p>
                <p className="font-mono text-[12px] text-ink">
                  {gapsFilled === selected.length
                    ? `${gapsFilled} gaps filled · nothing to enter`
                    : `${gapsFilled} of ${selected.length} filled by estimate · nothing to enter`}
                </p>
              </>
            ) : (
              <div className="mt-3 space-y-2.5">
                <div className="flex flex-wrap gap-x-4 gap-y-3">
                  <label className="flex-1 min-w-[148px]">
                    <span className={`${sectionLabel} block mb-1`}>First image</span>
                    <input
                      type="datetime-local"
                      step={1}
                      disabled={useModified}
                      value={startText}
                      onChange={(e) => setStartText(e.target.value)}
                      aria-label="First image capture time"
                      className={`${inputClass} w-full disabled:opacity-40`}
                    />
                    <span className="block font-body text-[11px] text-inkMute mt-1">
                      Time of the earliest selected file
                    </span>
                  </label>
                  <label className="flex-1 min-w-[120px]">
                    <span className={`${sectionLabel} block mb-1`}>Spacing</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      disabled={useModified}
                      value={spacing}
                      onChange={(e) => setSpacing(e.target.value)}
                      aria-label="Spacing in seconds"
                      className={`${inputClass} w-full disabled:opacity-40`}
                    />
                    <span className="block font-body text-[11px] text-inkMute mt-1">
                      From file order · seconds
                    </span>
                  </label>
                </div>
                <label className="flex items-center gap-2 font-body text-[12.5px] text-inkSoft">
                  <input
                    type="checkbox"
                    checked={useModified}
                    onChange={(e) => setUseModified(e.target.checked)}
                    className="accent-ink"
                  />
                  Use file modified times instead
                </label>
                {spreadFirst && spreadLast && (
                  <p className="font-mono text-[12px] text-ink">
                    {selected.length === 1
                      ? `1 file lands ${shortNaive(spreadFirst)}.`
                      : `${selected.length} files land ${rangeText(spreadFirst, spreadLast)}, in filename order.`}
                  </p>
                )}
                <button type="button" onClick={applySpread} disabled={!spread} className={buttonClass}>
                  Apply to {selected.length} {selected.length === 1 ? 'file' : 'files'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {timed.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className={sectionLabel}>
              Camera times ·{' '}
              <span className="font-mono normal-case tracking-normal">
                {minuteOf(naiveFromMillis(cameraMin))} – {minuteOf(naiveFromMillis(cameraMax))}
              </span>
            </p>
            <span className="inline-flex items-center gap-1.5 font-body text-[11px] text-inkMute">
              <span className="w-2.5 h-2.5 bg-accent" aria-hidden /> camera time ({timed.length})
            </span>
            <span className="inline-flex items-center gap-1.5 font-body text-[11px] text-inkMute">
              <span className="w-2.5 h-2.5 bg-warn" aria-hidden /> estimated ({missing.length})
            </span>
          </div>
          <div className="relative h-7 bg-ruleSoft mt-2">
            {cameraTicks.map(({ pct, opacity }) => (
              <i
                key={`c${pct}`}
                className="absolute top-[20%] w-px h-[60%] bg-accent"
                style={{ left: `${pct}%`, opacity }}
              />
            ))}
            {estimateTicks.map(({ pct, opacity }) => (
              <i
                key={`e${pct}`}
                className="absolute top-0 w-[3px] h-full bg-warn"
                style={{ left: `${pct}%`, opacity }}
              />
            ))}
          </div>
          <p className="font-body text-[11px] leading-snug text-inkMute mt-1.5">
            Interpolated times sit between their neighbours; offsets sit ten minutes apart past the
            ends.
            {outside > 0 && (
              <span className="text-warn">
                {' '}
                {outside} {outside === 1 ? 'lands' : 'land'} outside the camera-time range.
              </span>
            )}
          </p>
        </div>
      )}

      <div>
        <p className={sectionLabel}>
          Affected files · {selected.length} ·{' '}
          <span className="font-body font-normal normal-case tracking-normal text-inkMute">
            click a thumbnail to override
          </span>
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-2">
          {shown.map((f) => {
            const estimate = estimates.get(f.id);
            const { naive, source } = effectiveTime(f, estimates);
            return (
              <div
                key={f.id}
                className={`border border-ruleSoft bg-panel p-2 min-w-0 ${
                  editing === f.id ? 'col-span-2' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => setEditing((id) => (id === f.id ? null : f.id))}
                  aria-expanded={editing === f.id}
                  className="block text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Thumb blob={f.thumbnail} />
                  <span
                    className="block truncate font-mono text-[11.5px] text-ink mt-1.5"
                    title={f.relPath}
                  >
                    {f.fileName}
                  </span>
                  <span className="block font-mono text-[11px] text-inkSoft mt-1">
                    {naive ? shortNaive(naive) : '—'}{' '}
                    {source && (
                      <span
                        className={`inline-block font-body text-[10px] font-[600] tracking-[0.08em] uppercase px-1 ${
                          source === 'interpolated' || source === 'offset' || source === 'file-modified'
                            ? 'border border-dashed border-rule text-inkMute'
                            : 'border border-accent text-accent'
                        }`}
                      >
                        {sourceTag(source)}
                      </span>
                    )}
                  </span>
                </button>
                <div className="flex items-center gap-2 mt-1">
                  {editing === f.id && (
                    <input
                      type="datetime-local"
                      step={1}
                      autoFocus
                      aria-label={`Capture time for ${f.fileName}`}
                      value={f.manualNaive ? naiveToInputValue(f.manualNaive) : ''}
                      onChange={(e) => setManualNaive(f.id, inputValueToNaive(e.target.value))}
                      className={inputClass}
                    />
                  )}
                  <span className="font-body text-[11px] leading-snug text-inkMute min-w-0">
                    {f.manualNaive && estimate ? (
                      <button
                        type="button"
                        onClick={() => setManualNaive(f.id, null)}
                        className="text-inkMute hover:text-warn focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        ✕ back to estimate ({shortNaive(estimate.naive)})
                      </button>
                    ) : (
                      methodLine(f, estimate, uploadTimeZone, spreadStart)
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {!showAll && selected.length > shown.length && (
          <button type="button" onClick={() => setShowAll(true)} className={`${buttonClass} mt-2.5`}>
            Show all {selected.length}
          </button>
        )}
      </div>

      <p className="pt-1">
        <span className="inline-block border border-ruleSoft px-2 py-1 font-mono text-[11.5px] text-inkSoft">
          timestamp_issues → true
        </span>
        <span className="font-body text-[11px] text-inkMute ml-2">
          {missing.length} files without camera time
        </span>
      </p>
    </div>
  );
}
