import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { useStore } from '../store';
import { useTagImages, useSpecies } from '../lib/queries';
import { useMediaUrl } from '../lib/useMediaUrl';
import { parseCollectionKey } from '../lib/s3';
import { correctedTimestamp, shiftTimestamp } from '@sparcd/camtrap';
import { SpeciesPanel } from '../components/SpeciesPanel';
import { AppliedSpecies } from '../components/AppliedSpecies';
import { Cheatsheet } from '../components/Cheatsheet';
import { SyncDialog } from '../components/SyncDialog';
import { SnapshotsDialog } from '../components/SnapshotsDialog';
import { DiscardConfirmDialog } from '../components/DiscardConfirmDialog';
import { buildDiscardSummaries } from '../lib/discardSummary';
import { TimeShiftModal } from '../components/TimeShiftModal';
import { BulkTimeShiftModal } from '../components/BulkTimeShiftModal';
import { PerImageTime } from '../components/PerImageTime';
import { SpeciesLoupe } from '../components/SpeciesLoupe';
import { KeyConflictDialog } from '../components/KeyConflictDialog';
import { ImageAdjustments } from '../components/ImageAdjustments';
import { cssFilter, NEUTRAL, type Adjustments } from '../lib/adjustments';
import { Overview, type PickMods, type ViewKind } from '../components/Overview';
import { groupBursts, type BurstGrouping } from '../lib/bursts';
import { offsetActive, formatOffsetDelta, earliestCorrected } from '../lib/timeshift';
import { rangeSet, toggleIndex, burstIndexSet } from '../lib/selection';
import { effectiveOf, type Effective } from '../lib/effective';
import { sortIndices, type SortField, type SortDir } from '../lib/sortImages';
import { findFilenameMatches } from '../lib/imageSearch';
import { parseSpeciesDrag, SPECIES_DRAG_TYPE } from '../lib/speciesDrag';
import {
  useDraftStore,
  dirtyCount,
  type AppliedTag,
  type TagTarget,
  type BulkTimeTarget,
  type UploadCtx,
} from '../lib/drafts';
import {
  activeKeyProfile,
  conflictingKeyOwners,
  effectiveKey,
  normalizeBindableEventKey,
  useKeyBindings,
} from '../lib/keys';
import { useLocalBatch, saveLocalTags } from '../lib/localBatch';
import { localTagImages } from '../lib/localWorkspace';
import { DEFAULT_SPECIES } from '../lib/defaultSpecies';
import type { Species } from '../lib/species';
import { isVideoImage, type TagImage } from '../lib/workspace';
import type { DraftRecord } from '../lib/db';

const RECENT_LIMIT = 12;
const EMPTY: TagImage[] = []; // stable ref so memos don't churn before data loads

type View = 'overview' | 'focus';

type PendingKeyConflict = {
  scientificName: string;
  commonName: string;
  key: string;
  conflicts: Species[];
};

export function Tag() {
  const cfg = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const collectionKey = useStore((s) => s.selectedCollectionKey);
  const uploadPrefix = useStore((s) => s.selectedUploadPrefix);
  const burstGroupingEnabled = useStore((s) => s.burstGroupingEnabled);
  const burstThreshold = useStore((s) => s.burstThresholdSec);
  const pendingSnapshots = useStore((s) => s.pendingSnapshots);
  const clearPendingSnapshots = useStore((s) => s.clearPendingSnapshots);

  // A local batch bypasses the connection entirely, so both S3 queries below
  // are disabled (`cfg` is null) and their data comes from the record instead.
  const localRecord = useLocalBatch((s) => (s.status === 'ready' ? s.record : null));
  const needsGesture = useLocalBatch((s) => s.needsGesture);
  const attachOriginals = useLocalBatch((s) => s.attachOriginals);

  const images = useTagImages(cfg, connectionId, collectionKey, uploadPrefix);
  const species = useSpecies(cfg, connectionId);

  const localImages = useMemo(
    () => (localRecord ? localTagImages(localRecord) : EMPTY),
    [localRecord],
  );

  const { bucket } = collectionKey ? parseCollectionKey(collectionKey) : { bucket: '' };
  // Drafts are scoped by bucket + upload, and a local batch has neither — its
  // own id stands in, so re-entering the same hand-off resumes where it left off
  // and two batches never share draft rows.
  const ctx = useMemo<UploadCtx>(
    () =>
      localRecord
        ? { bucket: 'local', uploadPrefix: localRecord.id }
        : { bucket, uploadPrefix: uploadPrefix ?? '' },
    [localRecord, bucket, uploadPrefix],
  );

  const drafts = useDraftStore((s) => s.drafts);
  const timeOffset = useDraftStore((s) => s.timeOffset);
  const loadUpload = useDraftStore((s) => s.loadUpload);
  const addSpeciesFn = useDraftStore((s) => s.addSpecies);
  const incrementSpeciesFn = useDraftStore((s) => s.incrementSpecies);
  const removeSpeciesFn = useDraftStore((s) => s.removeSpecies);
  const setSpeciesCountFn = useDraftStore((s) => s.setSpeciesCount);
  const detagFn = useDraftStore((s) => s.detag);
  const setQuestionableManyFn = useDraftStore((s) => s.setQuestionableMany);
  const setTimeOffsetFn = useDraftStore((s) => s.setTimeOffset);
  const setTimeOverrideFn = useDraftStore((s) => s.setTimeOverride);
  const applyTimeOffsetToSelectionFn = useDraftStore((s) => s.applyTimeOffsetToSelection);
  const flushSaves = useDraftStore((s) => s.flushSaves);
  const discardUpload = useDraftStore((s) => s.discardUpload);

  // Hydrate drafts for this upload from Dexie when it changes.
  useEffect(() => {
    if (ctx.bucket && ctx.uploadPrefix) void loadUpload(ctx);
  }, [ctx, loadUpload]);

  const [view, setView] = useState<View>('overview');
  const [overviewKind, setOverviewKind] = useState<ViewKind>('grid');
  const [focus, setFocus] = useState(0);
  const [anchor, setAnchor] = useState(0); // last single pick — the base for Shift-range
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [pendingKeyConflict, setPendingKeyConflict] = useState<PendingKeyConflict | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [showTimeShift, setShowTimeShift] = useState(false);
  // Snapshot the bulk targets + preview anchor once when the modal opens — both
  // derive from the SAME corrected baseline, so the before→after preview always
  // matches what apply persists, and re-renders (spinner clicks) don't recompute.
  const [bulkTime, setBulkTime] = useState<{
    targets: BulkTimeTarget[];
    anchor: string;
    scope: 'focused-frame' | 'selection';
    requestedCount: number;
  } | null>(null);
  const [zoomSpecies, setZoomSpecies] = useState<Species | null>(null);
  // Synchronous mirror of "a read-only overlay is open", read by the global key
  // handler. A ref (not the async state) so it's already true for any keydown
  // that lands between opening the loupe and React committing the state.
  const modalOpenRef = useRef(false);
  const openLoupe = (sp: Species) => {
    modalOpenRef.current = true;
    setZoomSpecies(sp);
  };
  const closeLoupe = () => {
    modalOpenRef.current = false;
    setZoomSpecies(null);
  };
  // The scoped time-shift modal acts on a snapshotted selection, or on the
  // focused frame when no selection exists. Suppress tagger hotkeys behind it.
  const openBulkTime = () => {
    const targets = bulkTimeTargets;
    if (!targets.length) return;
    const scope = selected.size > 0 ? 'selection' : 'focused-frame';
    modalOpenRef.current = true;
    setBulkTime({
      targets,
      anchor: earliestCorrected(targets),
      scope,
      requestedCount: scope === 'selection' ? selected.size : 1,
    });
  };
  const closeBulkTime = () => {
    modalOpenRef.current = false;
    setBulkTime(null);
  };
  const [savedAt, setSavedAt] = useState(0);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const filterRef = useRef<HTMLInputElement>(null);

  // Sort a permutation of the canonical order, then map images through it. Every
  // downstream consumer (bursts, selection, keyboard nav) re-derives from `list`,
  // so ordering lives entirely here. Species count is draft-aware (effective), so
  // re-sorting by species stays live as tags change.
  const base = localRecord ? localImages : images.data ?? EMPTY;
  const speciesCountOf = (img: TagImage) => effectiveOf(img, drafts[img.key]).observations.length;
  const order = useMemo(
    () => sortIndices(base, speciesCountOf, sortField, sortDir),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, drafts, sortField, sortDir],
  );
  const list = useMemo(() => order.map((i) => base[i]), [base, order]);
  const current = list[focus];

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  // Find-image-by-name: jump keyboard focus to a filename match. Independent of
  // the species filter (a separate concern in SpeciesPanel). Jump-only — never
  // filters `list`, which would renumber the positional burst/selection indices.
  const [imgQuery, setImgQuery] = useState('');
  const [matchPos, setMatchPos] = useState(0);
  const imgSearchRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findFilenameMatches(list, imgQuery), [list, imgQuery]);

  const jumpToMatch = (pos: number) => {
    if (!matches.length) return;
    const wrapped = ((pos % matches.length) + matches.length) % matches.length;
    setMatchPos(wrapped);
    const idx = matches[wrapped];
    setFocus(idx);
    setAnchor(idx);
    setSelected(new Set());
  };

  // Auto-jump to the first match as the query changes (jump-as-you-type).
  useEffect(() => {
    if (matches.length) jumpToMatch(0);
    else setMatchPos(0);
    // jumpToMatch reads `matches`; depend on the query+matches, not the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgQuery, matches]);

  // An upload offset shifts every image equally, so it never changes a burst
  // gap — only the band labels. Feed the offset-corrected time so bands read the
  // corrected span; per-image overrides are rare and intentionally don't re-band
  // (keeps grouping off the per-keystroke draft path). Undefined → base time.
  const tsOf = useMemo(
    () =>
      offsetActive(timeOffset)
        ? (img: TagImage) => shiftTimestamp(img.baseTimestamp, timeOffset!)
        : undefined,
    [timeOffset],
  );

  // Burst grouping (visual bands + whole-burst selection / nav). Recomputed when
  // the image list, the per-session threshold, or the upload offset changes.
  const grouping = useMemo<BurstGrouping>(
    () => groupBursts(list, burstThreshold, burstGroupingEnabled, tsOf),
    [list, burstThreshold, burstGroupingEnabled, tsOf],
  );

  const sampleTimestamp = useMemo(() => list.find((i) => i.baseTimestamp)?.baseTimestamp ?? '', [
    list,
  ]);

  // Reset focus/selection when the upload changes / data arrives. Null the sort
  // permutation ref so the remap effect below treats the next `order` as a fresh
  // baseline rather than translating stale positions across a different upload.
  const prevOrderRef = useRef<number[] | null>(null);
  useEffect(() => {
    setFocus(0);
    setAnchor(0);
    setSelected(new Set());
    setImgQuery('');
    setMatchPos(0);
    prevOrderRef.current = null;
  }, [uploadPrefix, images.data]);

  // When only the sort order changes (a header click, or a draft edit while
  // sorting by species), the user's focus/anchor/selection are positions in the
  // OLD order. Translate them through old-position → canonical-index → new-position
  // so they stay on the SAME images instead of silently jumping.
  useEffect(() => {
    const prev = prevOrderRef.current;
    prevOrderRef.current = order;
    if (!prev || prev.length !== order.length || order.length === 0) return;
    const newPos = new Array<number>(order.length);
    order.forEach((baseIdx, pos) => {
      newPos[baseIdx] = pos;
    });
    const remap = (oldPos: number) => {
      const baseIdx = prev[oldPos];
      return baseIdx == null ? oldPos : newPos[baseIdx] ?? oldPos;
    };
    setFocus((f) => remap(f));
    setAnchor((a) => remap(a));
    setSelected((sel) => (sel.size ? new Set([...sel].map(remap)) : sel));
  }, [order]);

  // History routes here with `pendingSnapshots` set to jump straight into the
  // recovery dialog for the chosen upload; consume the flag once.
  useEffect(() => {
    if (pendingSnapshots) {
      setShowSnapshots(true);
      clearPendingSnapshots();
    }
  }, [pendingSnapshots, clearPendingSnapshots]);

  const overrides = useKeyBindings((state) => activeKeyProfile(state).overrides);
  const assignKey = useKeyBindings((state) => state.assignKey);
  const clearKey = useKeyBindings((state) => state.clearKey);
  const speciesList = localRecord ? DEFAULT_SPECIES : species.data?.species ?? [];

  const bindingFor = (sci: string): string | null => {
    const k = effectiveKey(sci, speciesJsonKey(speciesList, sci), overrides);
    return k ? k.toUpperCase() : null;
  };

  // key char → action, built once per species/override change.
  const keyMap = useMemo(() => {
    const m = new Map<string, { kind: 'species'; species: Species }>();
    for (const s of speciesList) {
      const key = effectiveKey(s.scientificName, s.keyBinding, overrides);
      if (key) m.set(key, { kind: 'species', species: s });
    }
    return m;
  }, [speciesList, overrides]);

  const captureKey = (scientificName: string, key: string) => {
    const target = speciesList.find((candidate) => candidate.scientificName === scientificName);
    if (!target) return;
    const owners = new Set(conflictingKeyOwners(speciesList, scientificName, key, overrides));
    const conflicts = speciesList.filter((candidate) => owners.has(candidate.scientificName));
    if (conflicts.length) {
      setPendingKeyConflict({
        scientificName,
        commonName: target.commonName,
        key,
        conflicts,
      });
      return;
    }
    assignKey(scientificName, key);
  };

  const confirmKeyReassignment = () => {
    if (!pendingKeyConflict) return;
    assignKey(
      pendingKeyConflict.scientificName,
      pendingKeyConflict.key,
      pendingKeyConflict.conflicts.map((owner) => owner.scientificName),
    );
    setPendingKeyConflict(null);
  };

  const pushRecent = (sci: string) =>
    setRecent((r) => [sci, ...r.filter((x) => x !== sci)].slice(0, RECENT_LIMIT));
  const [selectedSpecies, setSelectedSpecies] = useState<string | null>(null);

  // Operations target the selection when one exists, else the focused image.
  const targetsOf = (): TagTarget[] => {
    const idx = selected.size ? [...selected].sort((a, b) => a - b) : current ? [focus] : [];
    return idx
      .map((i) => list[i])
      .filter(Boolean)
      .map((img) => ({
        mediaPath: img.key,
        deploymentId: img.deploymentId,
        // Seed a fresh draft from the FULL canonical base set so a partial edit
        // (adding one species, toggling questionable) keeps every existing one.
        base: { observations: img.baseObservations },
      }));
  };

  const apply = (tag: AppliedTag) => {
    const targets = targetsOf();
    if (!targets.length) return;
    addSpeciesFn(ctx, targets, tag);
    if (tag.scientificName) pushRecent(tag.scientificName);
  };

  const applyIncrementAt = (index: number, tag: AppliedTag) => {
    // A drop is spatial: it updates only the image under the drop zone, even
    // if a multi-image selection still exists.
    const image = list[index];
    if (!image) return;
    incrementSpeciesFn(
      ctx,
      [
        {
          mediaPath: image.key,
          deploymentId: image.deploymentId,
          base: { observations: image.baseObservations },
        },
      ],
      tag,
    );
    if (tag.scientificName) pushRecent(tag.scientificName);
  };

  const applyIncrement = (tag: AppliedTag) => {
    // Keyboard bindings are selection-scoped, like the panel's explicit add
    // control. Keep this separate from spatial drag/drop targeting.
    const targets = targetsOf();
    if (!targets.length) return;
    incrementSpeciesFn(ctx, targets, tag);
    if (tag.scientificName) pushRecent(tag.scientificName);
  };

  // Selection-scoped bulk time shift: each target carries its currently-displayed
  // corrected time so the store can freeze (corrected + delta) into a per-image
  // override. Frames without a capture time have nothing to correct, so skip them.
  const bulkTimeTargets = useMemo(
    () =>
      (selected.size > 0 ? [...selected].map((i) => list[i]) : current ? [current] : [])
        .filter((img) => img && img.baseTimestamp)
        .map((img) => ({
          mediaPath: img.key,
          deploymentId: img.deploymentId,
          base: { observations: img.baseObservations },
          currentCorrected: correctedTimestamp(
            img.baseTimestamp,
            timeOffset,
            drafts[img.key]?.timeOverride ?? null,
          ),
        })),
    [selected, current, list, drafts, timeOffset],
  );
  const scopedTimeApplicableCount = bulkTimeTargets.length;
  const scopedTimeUnavailableReason = selected.size > 0
    ? 'None of the selected frames has a capture time to shift'
    : 'This frame has no capture time to shift';

  // --- Mouse selection gestures (single / Shift-range / Cmd-additive). --------
  const pick = (i: number, mods: PickMods) => {
    if (mods.shift) {
      setSelected(rangeSet(anchor, i));
      setFocus(i);
    } else if (mods.meta) {
      // Seed from the focused image so the first Cmd-click yields a two-image
      // selection (Finder-style) instead of restarting from the clicked one.
      setSelected(toggleIndex(selected.size ? selected : new Set([focus]), i));
      setFocus(i);
      setAnchor(i);
    } else {
      setFocus(i);
      setSelected(new Set());
      setAnchor(i);
    }
  };

  const selectBurst = (start: number) => {
    setSelected(burstIndexSet(grouping, start));
    setFocus(start);
    setAnchor(start);
  };

  const drill = (i: number) => {
    setFocus(i);
    setSelected(new Set());
    setAnchor(i);
    setView('focus');
  };

  // On-screen prev/next (Focus footer) mirror the j/k/arrow path: clamp, move
  // focus, re-anchor, clear any selection.
  const gotoImage = (i: number) => {
    const clamped = Math.max(0, Math.min(i, list.length - 1));
    setFocus(clamped);
    setAnchor(clamped);
    setSelected(new Set());
  };

  // On-screen questionable toggle mirrors Shift+Space: act on the selection
  // (or the focused image), flipping off the focused image's current state.
  const toggleQuestionable = () => {
    const targets = targetsOf();
    if (!targets.length || !current) return;
    const anchorDraft = drafts[current.key];
    setQuestionableManyFn(ctx, targets, !anchorDraft?.questionable);
  };

  // --- Global key handler: attached once, reads the latest state via a ref so
  // it never re-binds per render (plan perf requirement). ----------------------
  const stateRef = useRef<HandlerState>(null!);
  stateRef.current = {
    list,
    focus,
    setFocus,
    setAnchor,
    grouping,
    selected,
    setSelected,
    ctx,
    keyMap,
    capturingFor,
    setCapturingFor,
    captureKey,
    apply,
    applyIncrement,
    targetsOf,
    detag: detagFn,
    setQuestionableMany: setQuestionableManyFn,
    drafts,
    flushSaves,
    flashSaved: () => setSavedAt(Date.now()),
    showCheatsheet,
    setShowCheatsheet,
    filterRef,
    speciesList,
    filter,
    view,
    setView,
    isModalOpen: () =>
      modalOpenRef.current ||
      showDiscard ||
      showSync ||
      showSnapshots ||
      showTimeShift ||
      pendingKeyConflict !== null,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e, stateRef.current);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mirror the drafts into the shared record so the uploader reads the tags
  // back without knowing anything about the tagger's own database. Debounced on
  // top of the drafts' own debounce — this is a whole-record write, not a hot path.
  useEffect(() => {
    if (!localRecord) return;
    const timer = setTimeout(() => void saveLocalTags(localRecord.id, drafts), 400);
    return () => clearTimeout(timer);
  }, [localRecord, drafts]);

  // Transient "Saved" confirmation after Cmd/Ctrl+S.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(0), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Must stay above the early returns below — useMemo must be called unconditionally.
  const discardSummaries = useMemo(
    () =>
      buildDiscardSummaries(
        Object.values(drafts).filter((r) => r.dirty),
        list.map((image) => ({
          ...image,
          restoredTimestamp: correctedTimestamp(image.baseTimestamp, timeOffset, null),
        })),
      ),
    [drafts, list, timeOffset],
  );

  if (!localRecord) {
    if (!current && images.isLoading)
      return <Centered>Loading the upload’s canonical media…</Centered>;
    if (images.isError)
      return <Centered tone="warn">{(images.error as Error).message}</Centered>;
  }
  if (!list.length) return <Centered>This upload has no taggable images.</Centered>;

  const draft = current ? drafts[current.key] : undefined;
  const eff = current ? effectiveOf(current, draft) : null;
  const currentBase = current ? { observations: current.baseObservations } : undefined;
  const nDirty = dirtyCount(drafts);
  const discardDetails = discardSummaries.map(
    (summary) =>
      `${summary.displayName}: ${summary.changes.map((change) => change.label).join(', ') || 'local draft record'}`,
  );
  const discardTitle = `Discard ${nDirty} image${nDirty !== 1 ? 's' : ''}: ${discardDetails.join('; ')}`;
  const hasUploadShift = offsetActive(timeOffset);
  const correctedTs = current
    ? correctedTimestamp(current.baseTimestamp, timeOffset, draft?.timeOverride ?? null)
    : '';

  return (
    <div className="h-[100dvh] lg:h-full flex flex-col min-h-0">
      {/* Workspace toolbar: mode + view switches, position, selection, save */}
      <div className="shrink-0 min-h-10 border-b border-rule bg-panel flex flex-wrap items-center gap-3 gap-y-2 px-3">
        <Segmented
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'focus', label: 'Focus' },
          ]}
        />
        {view === 'overview' && (
          <Segmented
            value={overviewKind}
            onChange={(v) => setOverviewKind(v as ViewKind)}
            options={[
              { value: 'grid', label: '▦ Grid' },
              { value: 'list', label: '☰ List' },
            ]}
          />
        )}

        <span className="text-[12px] font-mono text-inkSoft">
          {selected.size > 0 ? (
            <span className="text-accent">{selected.size} selected</span>
          ) : (
            <>
              {focus + 1} / {list.length}
            </>
          )}
        </span>

        {/* Touch path for building a multi-select set (desktop uses Shift/Cmd
            click). Toggles the focused image in/out of the selection. */}
        <button
          onClick={() => setSelected(toggleIndex(selected, focus))}
          aria-pressed={selected.has(focus)}
          className="lg:hidden min-h-11 inline-flex items-center text-[11.5px] font-mono px-2 border border-rule text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-mark aria-pressed:border-ink aria-pressed:text-ink"
          title="Add or remove this image from the selection"
        >
          {selected.has(focus) ? '✓ In selection' : '＋ Select'}
        </button>

        {/* Upload time-shift entry + persistent active-offset indicator (§08). */}
        <button
          onClick={() => setShowTimeShift(true)}
          className={`inline-flex items-center gap-1.5 text-[11.5px] font-mono px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
            hasUploadShift
              ? 'bg-mark border border-ink text-ink font-[600]'
              : 'border border-rule text-inkSoft hover:text-ink hover:border-ink'
          }`}
          title={
            hasUploadShift
              ? 'Upload time shift is active — click to edit'
              : 'Shift every frame in this upload by a signed offset'
          }
        >
          <span aria-hidden>◷</span>
          {hasUploadShift ? `clock ${formatOffsetDelta(timeOffset)}` : 'Time shift'}
        </button>

        {/* Shift only the selected frames (or the focused frame when nothing is
            selected) — e.g. one mis-set camera in a mixed upload. Stored as
            per-image corrections, so it stacks on the upload offset. */}
        {!!current && (
          <>
            <button
              onClick={openBulkTime}
              aria-disabled={scopedTimeApplicableCount === 0}
              aria-describedby={scopedTimeApplicableCount === 0 ? 'scoped-time-unavailable' : undefined}
              className="inline-flex items-center gap-1.5 text-[11.5px] font-mono px-2 py-1 border border-rule text-inkSoft hover:text-ink hover:border-ink aria-disabled:opacity-40 aria-disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              title={
                scopedTimeApplicableCount === 0
                  ? scopedTimeUnavailableReason
                  : selected.size > 0
                  ? `Shift the ${selected.size} selected frame(s) by a signed offset`
                  : 'Shift this frame by a signed offset'
              }
            >
              <span aria-hidden>◷</span>
              {selected.size > 0 ? 'Shift selection' : 'Shift this frame'}
            </button>
            {scopedTimeApplicableCount === 0 && (
              <span id="scoped-time-unavailable" className="sr-only">
                {scopedTimeUnavailableReason}
              </span>
            )}
          </>
        )}

        {/* Find image by filename — jumps focus to a match (the virtualizer then
            scrolls it into view). Separate from the species filter. */}
        <div className="inline-flex items-center gap-1 border border-rule px-1.5 py-0.5">
          <span aria-hidden className="text-[12px] text-inkMute">
            ⌕
          </span>
          <input
            ref={imgSearchRef}
            value={imgQuery}
            onChange={(e) => setImgQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                jumpToMatch(matchPos + (e.shiftKey ? -1 : 1));
              } else if (e.key === 'Escape') {
                setImgQuery('');
                imgSearchRef.current?.blur();
              }
            }}
            placeholder="Find image…"
            className="w-28 bg-transparent text-[12px] font-mono text-ink placeholder:text-inkMute focus:outline-none"
            title="Find image by filename (Enter / Shift+Enter to cycle, / to focus)"
          />
          {imgQuery.trim() && (
            <>
              <span
                className={`text-[11px] font-mono ${matches.length ? 'text-accent' : 'text-warn'}`}
              >
                {matches.length ? matchPos + 1 : 0}/{matches.length}
              </span>
              <button
                onClick={() => jumpToMatch(matchPos - 1)}
                disabled={!matches.length}
                className="text-[12px] text-inkSoft hover:text-ink disabled:opacity-40 px-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                title="Previous match"
                aria-label="Previous match"
              >
                ‹
              </button>
              <button
                onClick={() => jumpToMatch(matchPos + 1)}
                disabled={!matches.length}
                className="text-[12px] text-inkSoft hover:text-ink disabled:opacity-40 px-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                title="Next match"
                aria-label="Next match"
              >
                ›
              </button>
              <button
                onClick={() => {
                  setImgQuery('');
                  imgSearchRef.current?.focus();
                }}
                className="text-[12px] text-inkMute hover:text-ink px-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                title="Clear"
                aria-label="Clear image search"
              >
                ✕
              </button>
            </>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {savedAt > 0 && <span className="text-[12px] font-mono text-accent">saved ✓</span>}
          {/* On-screen Save mirrors ⌘S for touch; desktop keeps the hotkey. */}
          <button
            onClick={() => {
              void flushSaves();
              setSavedAt(Date.now());
            }}
            className="lg:hidden min-h-11 text-[12px] font-mono border border-ink px-2.5 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title="Save local edits (⌘S)"
          >
            Save
          </button>
          {/* On-screen Help opens the same cheatsheet the ? key toggles. */}
          <button
            onClick={() => setShowCheatsheet(true)}
            className="lg:hidden min-h-11 min-w-11 grid place-items-center text-[14px] font-mono border border-rule text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title="Keyboard shortcuts & help"
            aria-label="Help"
          >
            ?
          </button>
          {nDirty > 0 && (
            <button
              onClick={() => setShowDiscard(true)}
              className="text-[11px] font-mono text-inkMute hover:text-warn underline decoration-dotted"
              title={discardTitle}
            >
              {nDirty} unsaved · discard
            </button>
          )}
          {!localRecord && (
            <>
              <button
                onClick={() => setShowSnapshots(true)}
                className="text-[12px] font-mono border border-rule px-2.5 py-1 text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                title="Browse and restore prior canonical snapshots of this upload"
              >
                Snapshots…
              </button>
              <button
                onClick={() => setShowSync(true)}
                className="text-[12px] font-mono border border-ink px-2.5 py-1 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                title="Review and sync local edits to the canonical S3 files"
              >
                Sync…
              </button>
            </>
          )}
        </div>
      </div>

      {needsGesture && (
        <div className="shrink-0 border-b border-rule bg-mark px-3 py-2 flex items-center gap-3 flex-wrap">
          <span className="text-[12.5px] font-body text-ink">
            Showing thumbnails. The browser wants a click before it will read the folder’s
            full-resolution images.
          </span>
          <button
            onClick={() => void attachOriginals()}
            className="text-[12px] font-mono border border-ink px-2.5 py-1 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open folder
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {view === 'overview' ? (
          <div className="h-full grid grid-cols-1 lg:grid-cols-[1fr_340px] min-h-0 overflow-y-auto lg:overflow-visible">
            <div className="flex flex-col min-h-[60svh] lg:min-h-0">
              <SortBar field={sortField} dir={sortDir} onSort={handleSort} />
              <div className="flex-1 min-h-0">
                <Overview
                  list={list}
                  grouping={grouping}
                  focus={focus}
                  selected={selected}
                  kind={overviewKind}
                  onPick={pick}
                  onSelectBurst={selectBurst}
                  onDrill={drill}
                  onDropSpecies={applyIncrementAt}
                />
              </div>
            </div>
            <SpeciesPanel {...speciesPanelProps()} />
          </div>
        ) : (
          <div className="h-full grid grid-cols-1 lg:grid-cols-[280px_1fr_340px] grid-rows-none lg:grid-rows-[minmax(0,1fr)] min-h-0 overflow-y-auto lg:overflow-visible">
            {/* On phones the 280px rail becomes a capped filmstrip above the
                image; lg:contents dissolves the wrapper so desktop keeps the
                Overview list as a direct grid child. */}
            <div className="h-[30svh] overflow-y-auto lg:h-auto lg:overflow-visible lg:contents">
              <Overview
                list={list}
                grouping={grouping}
                focus={focus}
                selected={selected}
                kind="list"
                onPick={pick}
                onSelectBurst={selectBurst}
              />
            </div>
            <FocusPane
              current={current}
              eff={eff}
              savedAt={savedAt}
              corrected={correctedTs}
              hasUploadShift={hasUploadShift}
              overridden={!!draft?.timeOverride}
              onSetTime={(iso) =>
                current && setTimeOverrideFn(ctx, current.key, current.deploymentId, currentBase, iso)
              }
              onClearTime={() =>
                current && setTimeOverrideFn(ctx, current.key, current.deploymentId, currentBase, null)
              }
              onDetag={() => detagFn(ctx, targetsOf())}
              onPrev={() => gotoImage(focus - 1)}
              onNext={() => gotoImage(focus + 1)}
              onToggleQuestionable={toggleQuestionable}
              onDropSpecies={(tag) => applyIncrementAt(focus, tag)}
            />
            <SpeciesPanel {...speciesPanelProps()} />
          </div>
        )}
      </div>

      {showCheatsheet && <Cheatsheet onClose={() => setShowCheatsheet(false)} />}
      {showDiscard && (
        <DiscardConfirmDialog
          summaries={discardSummaries}
          onConfirm={() => discardUpload(ctx)}
          onClose={() => setShowDiscard(false)}
        />
      )}
      {showSync && (
        <SyncDialog ctx={ctx} images={list} drafts={drafts} onClose={() => setShowSync(false)} />
      )}
      {showSnapshots && <SnapshotsDialog ctx={ctx} onClose={() => setShowSnapshots(false)} />}
      {showTimeShift && (
        <TimeShiftModal
          offset={timeOffset}
          sampleTimestamp={sampleTimestamp}
          totalFrames={list.length}
          onApply={(o) => setTimeOffsetFn(ctx, o)}
          onClose={() => setShowTimeShift(false)}
        />
      )}
      {bulkTime && (
        <BulkTimeShiftModal
          count={bulkTime.targets.length}
          requestedCount={bulkTime.requestedCount}
          scope={bulkTime.scope}
          anchorTimestamp={bulkTime.anchor}
          onApply={(delta) => applyTimeOffsetToSelectionFn(ctx, bulkTime.targets, delta)}
          onClose={closeBulkTime}
        />
      )}
      {zoomSpecies && <SpeciesLoupe species={zoomSpecies} onClose={closeLoupe} />}
      {pendingKeyConflict && (
        <KeyConflictDialog
          keyName={pendingKeyConflict.key}
          targetName={pendingKeyConflict.commonName}
          ownerNames={pendingKeyConflict.conflicts.map((owner) => owner.commonName)}
          onConfirm={confirmKeyReassignment}
          onCancel={() => setPendingKeyConflict(null)}
        />
      )}
    </div>
  );

  function speciesPanelProps() {
    const observations = eff?.observations ?? [];
    return {
      species: speciesList,
      onApply: apply,
      onZoom: openLoupe,
      selectedSpecies,
      onSelectSpecies: setSelectedSpecies,
      filter,
      onFilterChange: setFilter,
      filterRef,
      bindingFor,
      capturingFor,
      onStartCapture: setCapturingFor,
      onClearKey: clearKey,
      recent,
      appliedSet: new Set(observations.map((o) => o.scientificName)),
      hasFocus: !!current,
      selectionCount: selected.size,
      disabled: !current,
      // The compact applied-species strip edits the focused image only. Mounted
      // in the panel header so it covers both Overview and Focus layouts (the
      // same panel renders in both) with one site.
      headerSlot: (
        <AppliedSpecies
          observations={observations}
          disabled={!current}
          onSetCount={(sci, n) =>
            current && setSpeciesCountFn(ctx, current.key, current.deploymentId, currentBase, sci, n)
          }
          onRemove={(sci) =>
            current && removeSpeciesFn(ctx, current.key, current.deploymentId, currentBase, sci)
          }
          onDetagAll={() =>
            current &&
            detagFn(ctx, [
              {
                mediaPath: current.key,
                deploymentId: current.deploymentId,
                base: currentBase,
              },
            ])
          }
        />
      ),
    };
  }
}

// --- Focus view (single-image detail) ---------------------------------------
function FocusPane({
  current,
  eff,
  savedAt,
  corrected,
  hasUploadShift,
  overridden,
  onSetTime,
  onClearTime,
  onDetag,
  onPrev,
  onNext,
  onToggleQuestionable,
  onDropSpecies,
}: {
  current: TagImage | undefined;
  eff: Effective | null;
  savedAt: number;
  corrected: string;
  hasUploadShift: boolean;
  overridden: boolean;
  onSetTime: (iso: string) => void;
  onClearTime: () => void;
  onDetag: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleQuestionable: () => void;
  onDropSpecies: (tag: AppliedTag) => void;
}) {
  // View-only display adjustments live here so they reset to neutral when the
  // user leaves Focus (this component unmounts) and stay sticky while paging
  // through images within a Focus session — the night-frame burst workflow.
  const [adjustments, setAdjustments] = useState<Adjustments>(NEUTRAL);
  const filter = useMemo(() => cssFilter(adjustments), [adjustments]);
  const isVideo = !!current && isVideoImage(current);
  const showAdjust = !!current && !isVideo;

  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div className="flex flex-col min-h-[55svh] lg:min-h-0 bg-paper">
      <div
        className={`relative flex-1 min-h-0 grid place-items-center p-4 overflow-hidden${isDragOver ? ' ring-2 ring-inset ring-accent' : ''}`}
        data-testid="focus-drop-zone"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SPECIES_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const tag = parseSpeciesDrag(e.dataTransfer.getData(SPECIES_DRAG_TYPE));
          if (tag) onDropSpecies(tag);
        }}
      >
        {current && (
          <FocusImage
            objectKey={current.key}
            alt={current.fileName}
            isVideo={isVideo}
            filter={filter}
          />
        )}
        {showAdjust && (
          // On phones the zoom controls own bottom-right, so park adjustments at
          // top-left to keep both off the squeezed image; restore bottom-left ≥lg.
          <div className="absolute top-4 left-4 lg:top-auto lg:bottom-4 z-10">
            <ImageAdjustments
              value={adjustments}
              onChange={setAdjustments}
              onReset={() => setAdjustments(NEUTRAL)}
            />
          </div>
        )}
      </div>
      {current && eff && (
        <div className="shrink-0 border-t border-rule bg-panel px-5 py-3 flex items-center gap-5 flex-wrap">
          {/* On-screen prev/next mirror the arrow keys for touch. */}
          <div className="lg:hidden flex items-center gap-2">
            <button
              onClick={onPrev}
              className="min-h-11 min-w-11 grid place-items-center text-[18px] leading-none border border-rule text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              title="Previous image (Arrow Up)"
              aria-label="Previous image"
            >
              ‹
            </button>
            <button
              onClick={onNext}
              className="min-h-11 min-w-11 grid place-items-center text-[18px] leading-none border border-rule text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              title="Next image (Arrow Down)"
              aria-label="Next image"
            >
              ›
            </button>
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-mono text-ink truncate" title={current.fileName}>
              {current.fileName} <span className="text-inkMute">· {shortDeployment(current.deploymentId)}</span>
            </div>
            <div className="mt-1">
              <PerImageTime
                original={current.baseTimestamp}
                corrected={corrected}
                hasUploadShift={hasUploadShift}
                overridden={overridden}
                onSet={onSetTime}
                onClear={onClearTime}
              />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {savedAt > 0 && <span className="text-[12px] font-mono text-accent">saved ✓</span>}
            {eff.questionable && (
              <span className="text-[12px] font-mono text-warn border border-warn px-2 py-0.5">
                questionable
              </span>
            )}
            {/* The applied species themselves render in the SpeciesPanel header
                strip on the right; the footer keeps only questionable + Detag. */}
            {/* Touch toggle mirrors Shift+Space; desktop relies on the hotkey
                and the display-only badge above. */}
            <button
              onClick={onToggleQuestionable}
              disabled={!current}
              aria-pressed={eff.questionable}
              className="lg:hidden min-h-11 text-[13px] border border-rule px-2.5 text-inkSoft hover:text-ink hover:border-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-mark aria-pressed:border-warn aria-pressed:text-warn"
              title="Toggle questionable (Shift+Space)"
            >
              {eff.questionable ? '✓ Questionable' : 'Questionable'}
            </button>
            <button
              onClick={onDetag}
              disabled={eff.observations.length === 0}
              className="text-[13px] border border-rule px-2.5 py-1 text-inkSoft hover:text-ink hover:border-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              title="Remove every species from this image"
            >
              Detag
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const SORT_FIELDS: { field: SortField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'type', label: 'Type' },
  { field: 'date', label: 'Date' },
  { field: 'species', label: 'Species' },
];

// A thin toolbar above the Overview. Clicking a field sorts by it; clicking the
// active field flips direction. Drives both grid and list views off one state.
function SortBar({
  field,
  dir,
  onSort,
}: {
  field: SortField;
  dir: SortDir;
  onSort: (f: SortField) => void;
}) {
  return (
    <div className="shrink-0 flex items-center gap-4 px-3 h-8 min-h-11 sm:min-h-0 border-b border-rule bg-panel">
      <span className="text-[11px] font-[600] tracking-[0.14em] uppercase text-inkMute">Sort</span>
      {SORT_FIELDS.map((s) => {
        const active = s.field === field;
        return (
          <button
            key={s.field}
            onClick={() => onSort(s.field)}
            aria-pressed={active}
            className={`text-[11px] font-[600] tracking-[0.14em] uppercase min-h-11 sm:min-h-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
              active ? 'text-ink' : 'text-inkSoft hover:text-ink'
            }`}
          >
            {s.label}
            {active && <span className="ml-1">{dir === 'asc' ? '▲' : '▼'}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex border border-rule">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`px-2.5 py-1 min-h-11 sm:min-h-0 text-[12px] font-mono focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
            o.value === value ? 'bg-ink text-paper' : 'text-inkSoft hover:bg-panelHover'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FocusImage({
  objectKey,
  alt,
  isVideo,
  filter,
}: {
  objectKey: string;
  alt: string;
  isVideo: boolean;
  filter?: string;
}) {
  const { url, isError } = useMediaUrl(objectKey);
  if (isError)
    return <div className="text-[13px] font-mono text-warn">Could not load this image.</div>;
  if (!url) return <div className="text-[13px] font-mono text-inkMute">…</div>;
  if (isVideo) return <FocusVideo src={url} alt={alt} resetKey={objectKey} />;
  return <ZoomableImage src={url} alt={alt} resetKey={objectKey} filter={filter} />;
}

// Video media plays with native controls. No zoom/pan/Lightbox: the
// react-zoom-pan-pinch wrapper captures wheel/pointer events and would fight
// native scrubbing. `key={resetKey}` recreates the element on navigation so the
// prior clip's playback/seek state never bleeds into the next one.
function FocusVideo({ src, alt, resetKey }: { src: string; alt: string; resetKey: string }) {
  return (
    <video
      key={resetKey}
      src={src}
      aria-label={alt}
      controls
      playsInline
      preload="metadata"
      className="w-full h-full object-contain"
    />
  );
}

const ZOOM_PROPS = {
  minScale: 1,
  maxScale: 6,
  centerOnInit: true,
  centerZoomedOut: true,
  limitToBounds: true,
  wheel: { step: 0.2 },
  doubleClick: { mode: 'zoomIn' as const, step: 0.7 },
  panning: { velocityDisabled: true },
};

function ZoomableImage({
  src,
  alt,
  resetKey,
  filter,
}: {
  src: string;
  alt: string;
  resetKey: string;
  filter?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  return (
    <>
      {/* key forces a fresh fit-to-view (reset zoom/pan) on every image change */}
      <TransformWrapper
        key={resetKey}
        {...ZOOM_PROPS}
        onTransform={(_, s) => setZoomed(s.scale > 1.01)}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperClass="!w-full !h-full cursor-grab active:cursor-grabbing"
              contentClass="!w-full !h-full"
            >
              <img
                src={src}
                alt={alt}
                draggable={false}
                style={filter ? { filter } : undefined}
                className="w-full h-full object-contain select-none"
              />
            </TransformComponent>
            <ZoomControls
              onIn={() => zoomIn()}
              onOut={() => zoomOut()}
              onExpand={() => setExpanded(true)}
              onReset={zoomed ? () => resetTransform() : undefined}
            />
          </>
        )}
      </TransformWrapper>
      {expanded && <Lightbox src={src} alt={alt} filter={filter} onClose={() => setExpanded(false)} />}
    </>
  );
}

function Lightbox({
  src,
  alt,
  filter,
  onClose,
}: {
  src: string;
  alt: string;
  filter?: string;
  onClose: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-ink/90 grid grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[13px] font-mono text-paper/80 truncate">{alt}</span>
        <button
          type="button"
          onClick={onClose}
          className="w-11 h-11 md:w-8 md:h-8 grid place-items-center text-[18px] leading-none text-paper/80 hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          title="Close (Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="relative min-h-0" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <TransformWrapper {...ZOOM_PROPS} maxScale={10} onTransform={(_, s) => setZoomed(s.scale > 1.01)}>
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <TransformComponent
                wrapperClass="!w-full !h-full cursor-grab active:cursor-grabbing"
                contentClass="!w-full !h-full"
              >
                <img
                  src={src}
                  alt={alt}
                  draggable={false}
                  style={filter ? { filter } : undefined}
                  className="w-full h-full object-contain select-none"
                />
              </TransformComponent>
              <ZoomControls
                onIn={() => zoomIn()}
                onOut={() => zoomOut()}
                onReset={zoomed ? () => resetTransform() : undefined}
                dark
              />
            </>
          )}
        </TransformWrapper>
      </div>
    </div>,
    document.body,
  );
}

function ZoomControls({
  onIn,
  onOut,
  onExpand,
  onReset,
  dark,
}: {
  onIn: () => void;
  onOut: () => void;
  onExpand?: () => void;
  onReset?: () => void;
  dark?: boolean;
}) {
  const tone = dark
    ? 'text-paper/80 hover:text-paper hover:bg-paper/10'
    : 'text-inkSoft hover:text-ink hover:bg-paper';
  const surface = dark
    ? 'bg-ink/60 border-paper/20 divide-paper/20'
    : 'bg-panel/90 border-rule divide-rule';
  const btn = `w-11 h-11 md:w-8 md:h-8 grid place-items-center text-[15px] leading-none ${tone} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`;
  return (
    <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className={`flex items-center gap-1.5 px-3 h-11 md:h-8 border shadow-sm text-[13px] font-mono ${surface} ${tone} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
          title="Reset to fit"
        >
          ⤢ Reset
        </button>
      )}
      <div className={`flex flex-col border divide-y shadow-sm ${surface}`}>
        <button type="button" onClick={onIn} className={btn} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={onOut} className={btn} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            className={`${btn} text-[12px]`}
            title="Open fullscreen"
            aria-label="Open fullscreen"
          >
            ⤢
          </button>
        )}
      </div>
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <div className="h-full grid place-items-center p-8">
      <p className={`text-[15px] font-body ${tone === 'warn' ? 'text-warn' : 'text-inkMute'}`}>
        {children}
      </p>
    </div>
  );
}

// The deploymentId is "<collection-uuid>:<location-id>"; show the readable tail.
function shortDeployment(deploymentId: string): string {
  const tail = deploymentId.split(':').pop() ?? deploymentId;
  return tail || deploymentId;
}

function speciesJsonKey(list: Species[], sci: string): string | null {
  return list.find((s) => s.scientificName === sci)?.keyBinding ?? null;
}

// --- Global key handler -----------------------------------------------------

type HandlerState = {
  list: TagImage[];
  focus: number;
  setFocus: (n: number) => void;
  setAnchor: (n: number) => void;
  grouping: BurstGrouping;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  ctx: UploadCtx;
  keyMap: Map<string, { kind: 'species'; species: Species }>;
  capturingFor: string | null;
  setCapturingFor: (v: string | null) => void;
  captureKey: (sci: string, key: string) => void;
  apply: (tag: AppliedTag) => void;
  applyIncrement: (tag: AppliedTag) => void;
  targetsOf: () => TagTarget[];
  detag: (ctx: UploadCtx, targets: TagTarget[]) => void;
  setQuestionableMany: (ctx: UploadCtx, targets: TagTarget[], value: boolean) => void;
  drafts: Record<string, DraftRecord>;
  flushSaves: () => Promise<void>;
  flashSaved: () => void;
  showCheatsheet: boolean;
  setShowCheatsheet: (v: boolean) => void;
  filterRef: React.RefObject<HTMLInputElement>;
  speciesList: Species[];
  filter: string;
  view: View;
  setView: (v: View) => void;
  isModalOpen: () => boolean; // an overlay (loupe, or the Sync/Snapshots/Time-shift dialogs) owns the keys
};

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// A focused <video>/<audio> owns its own keys (Space = play/pause, arrows =
// seek/volume). Let the browser handle them rather than letting a tagger hotkey
// fire — otherwise Space steals focus to the filter and letter keys tag the clip.
function isMediaTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');
}

/** Move focus to image `i`, clearing selection and re-anchoring range-select. */
function focusMove(s: HandlerState, i: number): void {
  const clamped = Math.max(0, Math.min(i, s.list.length - 1));
  s.setFocus(clamped);
  s.setAnchor(clamped);
  s.setSelected(new Set());
}

/** Move focus to the start of the burst `dir` away, clearing selection. */
function gotoBurst(s: HandlerState, dir: 1 | -1): void {
  const curBurst = s.grouping.burstOf[s.focus] ?? 0;
  const target = Math.max(0, Math.min(curBurst + dir, s.grouping.bursts.length - 1));
  const b = s.grouping.bursts[target];
  if (!b) return;
  focusMove(s, b.start);
}

function handleKey(e: KeyboardEvent, s: HandlerState): void {
  // An overlay owns the keyboard while open — the species loupe, or the
  // Sync/Snapshots/Time-shift dialogs. Suppress all tagger hotkeys so nothing
  // is tagged or navigated behind the modal; a keystroke landing on a frame
  // mid-sync would create a draft edit the sync then silently clears.
  if (s.isModalOpen()) return;

  // Cheatsheet modal swallows everything but its own toggle / dismiss.
  if (s.showCheatsheet) {
    if (e.key === '?' || e.key === 'Escape') {
      e.preventDefault();
      s.setShowCheatsheet(false);
    }
    return;
  }

  // Key-capture mode for "assign key" — swallow the next printable key.
  if (s.capturingFor) {
    if (e.key === 'Escape') {
      s.setCapturingFor(null);
      return;
    }
    const key = normalizeBindableEventKey(e);
    if (key) {
      e.preventDefault();
      s.captureKey(s.capturingFor, key);
      s.setCapturingFor(null);
    }
    return;
  }

  // A focused video/audio control handles its own keys natively; don't let any
  // tagger hotkey fire while the user is scrubbing or playing.
  if (isMediaTarget(e.target)) return;

  const typing = isTypingTarget(e.target);

  // Any focused text input suppresses the tagger hotkeys. The Escape/Enter
  // species-filter behavior is scoped to the species filter input ONLY — other
  // inputs (e.g. the find-image-by-name box) own their own keys, so Enter there
  // never applies a species tag.
  if (typing) {
    if (e.target === s.filterRef.current) {
      if (e.key === 'Escape') s.filterRef.current?.blur();
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = s.filter.trim().toLowerCase();
        const match =
          q &&
          s.speciesList.find(
            (sp) =>
              sp.commonName.toLowerCase().includes(q) ||
              sp.scientificName.toLowerCase().includes(q),
          );
        if (match)
          s.apply({ scientificName: match.scientificName, commonName: match.commonName, count: 1 });
        s.filterRef.current?.blur();
      }
    }
    return;
  }

  // User-assigned printable species keys take precedence over built-in
  // single-character shortcuts. This makes every alphanumeric and symbol key
  // usable; assigning j/k/x/? intentionally displaces that app shortcut.
  const current = s.list[s.focus];
  const printableKey = normalizeBindableEventKey(e);
  const speciesAction = printableKey
    ? s.keyMap.get(printableKey)
    : undefined;
  if (speciesAction && current) {
    e.preventDefault();
    if (e.repeat) return;
    s.applyIncrement({
      scientificName: speciesAction.species.scientificName,
      commonName: speciesAction.species.commonName,
      count: 1,
    });
    return;
  }

  // `?` toggles the cheatsheet (it arrives as Shift+/, so handle before the
  // Shift/modifier guards below).
  if (e.key === '?') {
    e.preventDefault();
    s.setShowCheatsheet(true);
    return;
  }

  // Cmd/Ctrl combos: select-burst (A) and save-now (S).
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === 'a') {
      e.preventDefault();
      s.setSelected(burstIndexSet(s.grouping, s.focus));
      s.setAnchor(s.focus);
    } else if (k === 's') {
      e.preventDefault();
      void s.flushSaves();
      s.flashSaved();
    }
    return;
  }
  if (e.altKey) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusMove(s, s.focus + 1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      focusMove(s, s.focus - 1);
      return;
    case 'PageDown':
      e.preventDefault();
      gotoBurst(s, 1);
      return;
    case 'PageUp':
      e.preventDefault();
      gotoBurst(s, -1);
      return;
    case ' ':
      e.preventDefault();
      if (e.shiftKey) {
        const targets = s.targetsOf();
        if (!targets.length || !current) return;
        const anchorDraft = s.drafts[current.key];
        s.setQuestionableMany(s.ctx, targets, !anchorDraft?.questionable);
        return;
      }
      s.filterRef.current?.focus();
      return;
    case 'Enter':
      // Drill the focused image into the Focus view from the Overview.
      if (s.view === 'overview') {
        e.preventDefault();
        s.setView('focus');
      }
      return;
    case 'Escape':
      if (s.selected.size) s.setSelected(new Set());
      return;
  }
}
