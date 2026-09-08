import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Thumb } from './Thumb';
import { useDraftStore } from '../lib/drafts';
import { effectiveOf, isEditedFromBase, isGhostObs } from '../lib/effective';
import { isRangeFullySelected } from '../lib/selection';
import type { Burst, BurstGrouping } from '../lib/bursts';
import { isVideoImage, type TagImage } from '../lib/workspace';
import type { DraftObservation } from '../lib/db';
import type { AppliedTag } from '../lib/drafts';
import { parseSpeciesDrag, SPECIES_DRAG_TYPE } from '../lib/speciesDrag';

/** A one-line label for an image's effective species set: the first species (with
 *  count when >1), plus `+N` when more follow. Ghost reads as "Ghost". */
function summarize(obs: DraftObservation[]): string {
  if (!obs.length) return '';
  const first = obs[0];
  const name = isGhostObs(first) ? 'Ghost' : first.commonName || first.scientificName;
  const head = first.count > 1 ? `${name} ×${first.count}` : name;
  return obs.length > 1 ? `${head} +${obs.length - 1}` : head;
}

// The Overview is the primary bulk-tagging surface: a virtualized, burst-banded
// view of an upload in either grid or list form. Only visible cells mount, so a
// 5,000-image upload scrolls smoothly and a selection change re-renders just the
// handful of on-screen cells. Reused at narrow width as the Focus view's side
// strip (always list there).

export type PickMods = { shift: boolean; meta: boolean };
export type ViewKind = 'grid' | 'list';

type OverviewProps = {
  list: TagImage[];
  grouping: BurstGrouping;
  focus: number;
  selected: Set<number>;
  kind: ViewKind;
  onPick: (i: number, mods: PickMods) => void;
  onSelectBurst: (start: number) => void;
  /** Drill one image into the Focus view (Overview mode only; omit for the strip). */
  onDrill?: (i: number) => void;
  /** A spatial drop affects this image only, regardless of selection. */
  onDropSpecies?: (i: number, tag: AppliedTag) => void;
};

const BAND_H = 30;
const LIST_ROW_H = 56;
const GRID_CARD_H = 158;
const GRID_GAP = 8;
const GRID_CELL_MIN = 150; // target card width; columns derive from container width

type FlatItem =
  | { kind: 'band'; burst: Burst }
  | { kind: 'row'; indices: number[] };

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** Measure a element's content width, tracking resizes (drives grid columns). */
function useElementWidth(ref: React.RefObject<HTMLElement>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function Overview({
  list,
  grouping,
  focus,
  selected,
  kind,
  onPick,
  onSelectBurst,
  onDrill,
  onDropSpecies,
}: OverviewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(parentRef);

  const cols =
    kind === 'list' ? 1 : Math.max(1, Math.floor((width + GRID_GAP) / (GRID_CELL_MIN + GRID_GAP)));

  // Flatten bursts → a single array of band/row items the virtualizer indexes.
  // `rowOfImage[i]` maps an image index back to its flat row so keyboard focus
  // can scroll the right row into view.
  const { flat, rowOfImage } = useMemo(() => {
    const items: FlatItem[] = [];
    const rowOf = new Array<number>(list.length);
    for (const b of grouping.bursts) {
      if (grouping.banded) items.push({ kind: 'band', burst: b });
      for (let i = b.start; i <= b.end; i += cols) {
        const indices = range(i, Math.min(i + cols - 1, b.end));
        const rowIdx = items.length;
        for (const idx of indices) rowOf[idx] = rowIdx;
        items.push({ kind: 'row', indices });
      }
    }
    return { flat: items, rowOfImage: rowOf };
  }, [grouping, cols, list.length]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) =>
      flat[i].kind === 'band' ? BAND_H : kind === 'list' ? LIST_ROW_H : GRID_CARD_H,
    overscan: 8,
  });

  // Keep the keyboard-focused image scrolled into view.
  useEffect(() => {
    const row = rowOfImage[focus];
    if (row != null) virtualizer.scrollToIndex(row, { align: 'auto' });
  }, [focus, rowOfImage, virtualizer]);

  return (
    <div ref={parentRef} className="h-full overflow-y-auto min-h-0 bg-panel">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const item = flat[vi.index];
          const style = {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vi.start}px)`,
          };
          if (item.kind === 'band') {
            return (
              <div key={`band-${item.burst.id}`} style={{ ...style, height: BAND_H }}>
                <BurstBand
                  burst={item.burst}
                  fullySelected={isRangeFullySelected(item.burst.start, item.burst.end, selected)}
                  onSelect={() => onSelectBurst(item.burst.start)}
                />
              </div>
            );
          }
          return (
            <div
              key={`row-${vi.index}`}
              style={{ ...style, height: kind === 'list' ? LIST_ROW_H : GRID_CARD_H }}
            >
              {kind === 'list' ? (
                <ListCell
                  img={list[item.indices[0]]}
                  index={item.indices[0]}
                  active={item.indices[0] === focus}
                  selected={selected.has(item.indices[0])}
                  onPick={onPick}
                  onDrill={onDrill}
                  onDropSpecies={onDropSpecies}
                />
              ) : (
                <div
                  className="grid gap-2 px-2 h-full"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                  {item.indices.map((idx) => (
                    <GridCell
                      key={list[idx].key}
                      img={list[idx]}
                      index={idx}
                      active={idx === focus}
                      selected={selected.has(idx)}
                      onPick={onPick}
                      onDrill={onDrill}
                      onDropSpecies={onDropSpecies}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function modsOf(e: React.MouseEvent): PickMods {
  return { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey };
}

// Two quick Cmd/Shift-clicks are selection gestures, not a request to drill —
// drilling would wipe the selection and yank the view to focus.
function plainDrill(e: React.MouseEvent, onDrill: (i: number) => void, index: number): void {
  if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onDrill(index);
}

function BurstBand({
  burst,
  fullySelected,
  onSelect,
}: {
  burst: Burst;
  fullySelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 h-full border-b border-rule ${
        fullySelected ? 'bg-mark' : 'bg-paperHover'
      }`}
    >
      <span className="text-[11px] font-mono text-inkSoft truncate">
        Burst {burst.id + 1} · {burst.size} img · {burstSpan(burst)}
      </span>
      <button
        onClick={onSelect}
        className="ml-auto text-[11px] font-mono text-inkMute hover:text-accent underline decoration-dotted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent [@media(hover:none)]:inline-flex [@media(hover:none)]:items-center [@media(hover:none)]:justify-center [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11 [@media(hover:none)]:px-3 [@media(hover:none)]:no-underline [@media(hover:none)]:border [@media(hover:none)]:border-rule [@media(hover:none)]:text-accent"
        title="Select this burst (⌘/Ctrl+A on the current burst)"
      >
        select
      </button>
    </div>
  );
}

// Each cell subscribes only to its own draft, so tagging one image never
// re-renders its neighbours (on top of virtualization already bounding the count).
function ListCell({
  img,
  index,
  active,
  selected,
  onPick,
  onDrill,
  onDropSpecies,
}: {
  img: TagImage;
  index: number;
  active: boolean;
  selected: boolean;
  onPick: (i: number, mods: PickMods) => void;
  onDrill?: (i: number) => void;
  onDropSpecies?: (i: number, tag: AppliedTag) => void;
}) {
  const draft = useDraftStore((s) => s.drafts[img.key]);
  const eff = effectiveOf(img, draft);
  return (
    <button
      {...speciesDropProps(index, onDropSpecies)}
      onClick={(e) => onPick(index, modsOf(e))}
      onDoubleClick={onDrill ? (e) => plainDrill(e, onDrill, index) : undefined}
      aria-current={active ? 'true' : undefined}
      className={`w-full h-full flex items-center gap-2.5 px-2.5 text-left border-b border-ruleSoft border-l-2 ${
        selected
          ? 'border-l-accent bg-mark'
          : active
            ? 'border-l-transparent bg-mark'
            : 'border-l-transparent hover:bg-panelHover'
      }`}
    >
      <span className="w-12 shrink-0">
        <Thumb objectKey={img.key} alt={img.fileName} isVideo={isVideoImage(img)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {isVideoImage(img) && (
            <span className="shrink-0 bg-paperHover border border-rule text-inkSoft font-mono text-[10px] px-1 leading-tight">
              VIDEO
            </span>
          )}
          <span
            className="block text-[12px] font-mono text-inkSoft truncate"
            title={img.fileName}
          >
            {img.fileName}
          </span>
        </span>
        <span className="block text-[12px] truncate">
          {eff.observations.length ? (
            <span className="text-ink">{summarize(eff.observations)}</span>
          ) : (
            <span className="text-inkMute">untagged</span>
          )}
        </span>
      </span>
      <span className="shrink-0 flex flex-col items-end gap-0.5">
        {isEditedFromBase(eff) && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent" title="unsaved edit" />
        )}
        {eff.questionable && (
          <span className="text-[11px] text-warn" title="questionable">
            ?
          </span>
        )}
        <span className="text-[11px] font-mono text-inkMute">{index + 1}</span>
      </span>
      {onDrill && (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Open in focus view"
          onClick={(e) => {
            e.stopPropagation();
            onDrill(index);
          }}
          className="hidden [@media(hover:none)]:flex items-center justify-center shrink-0 min-h-11 min-w-11 text-inkMute text-base"
        >
          ›
        </span>
      )}
    </button>
  );
}

function GridCell({
  img,
  index,
  active,
  selected,
  onPick,
  onDrill,
  onDropSpecies,
}: {
  img: TagImage;
  index: number;
  active: boolean;
  selected: boolean;
  onPick: (i: number, mods: PickMods) => void;
  onDrill?: (i: number) => void;
  onDropSpecies?: (i: number, tag: AppliedTag) => void;
}) {
  const draft = useDraftStore((s) => s.drafts[img.key]);
  const eff = effectiveOf(img, draft);
  return (
    <button
      {...speciesDropProps(index, onDropSpecies)}
      onClick={(e) => onPick(index, modsOf(e))}
      onDoubleClick={onDrill ? (e) => plainDrill(e, onDrill, index) : undefined}
      aria-current={active ? 'true' : undefined}
      title={img.fileName}
      className={`group relative flex flex-col text-left border p-1 ${
        selected
          ? 'border-accent ring-2 ring-inset ring-accent bg-mark'
          : active
            ? 'border-ink bg-mark'
            : 'border-rule hover:bg-panelHover'
      } focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent -outline-offset-2`}
    >
      <span className="relative block flex-1 min-h-0">
        <Thumb objectKey={img.key} alt={img.fileName} isVideo={isVideoImage(img)} />
        {isVideoImage(img) && (
          <span className="absolute top-1 left-1 bg-paperHover border border-rule text-inkSoft font-mono text-[10px] px-1 leading-tight">
            VIDEO
          </span>
        )}
        {onDrill && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Open in focus view"
            onClick={(e) => {
              e.stopPropagation();
              onDrill(index);
            }}
            className="hidden [@media(hover:none)]:flex absolute top-1 right-1 items-center justify-center min-h-11 min-w-11 bg-panel/80 border border-rule text-inkMute text-base"
          >
            ›
          </span>
        )}
      </span>
      <span className="mt-1 flex items-center gap-1">
        {isEditedFromBase(eff) && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="unsaved edit" />
        )}
        {eff.questionable && (
          <span className="text-[11px] text-warn shrink-0" title="questionable">
            ?
          </span>
        )}
        <span className="block text-[11px] truncate">
          {eff.observations.length ? (
            <span className="text-ink">{summarize(eff.observations)}</span>
          ) : (
            <span className="text-inkMute font-mono">{img.fileName}</span>
          )}
        </span>
      </span>
    </button>
  );
}

function speciesDropProps(index: number, onDropSpecies?: (i: number, tag: AppliedTag) => void) {
  if (!onDropSpecies) return {};
  return {
    onDragOver: (e: React.DragEvent<HTMLButtonElement>) => {
      if (!e.dataTransfer.types.includes(SPECIES_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (e: React.DragEvent<HTMLButtonElement>) => {
      const tag = parseSpeciesDrag(e.dataTransfer.getData(SPECIES_DRAG_TYPE));
      if (!tag) return;
      e.preventDefault();
      e.stopPropagation();
      onDropSpecies(index, tag);
    },
  };
}

function burstSpan(b: Burst): string {
  const t = (iso: string) => (iso ? iso.slice(11, 19) : '—');
  return b.startTs === b.endTs ? t(b.startTs) : `${t(b.startTs)}–${t(b.endTs)}`;
}
