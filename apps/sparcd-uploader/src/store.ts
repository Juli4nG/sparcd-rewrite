import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { S3Config } from '@sparcd/types';
import {
  loadPersistedConnection,
  loadSessionConnection,
  saveSharedConnection,
  clearSharedConnection,
  subscribeSharedConnection,
  loadSharedTheme,
  saveSharedTheme,
  type Theme,
} from '@sparcd/auth-ui';
import type { FlipObservation } from '@sparcd/flip';
import type { ScannedFile } from './lib/scanFiles';
import type { ProcessResponse } from './lib/processPool';
import type { FileAccessMode, LoadedSession } from './lib/db';
import type { ReconcileProblem } from './lib/resume';
import type { UploadRun, StreamingUploadRun, UploadSnapshot } from './lib/upload';
import {
  captureTimeComplete,
  processingComplete,
  validateBatch,
  validateFile,
  type FileValidation,
} from './lib/validation';
import { clearClientCache } from './lib/s3';
import { localTimeZone, type NaiveDateTime } from './lib/exifTime';
import type { ElevationUnit } from './lib/coords';
import { loadSession } from './lib/db';
import { resumeUpload } from './lib/upload';

export type { ElevationUnit };
export type Section = 'new' | 'history' | 'settings';
export type WizardStep = 'drop' | 'inspect' | 'assign' | 'upload';
export type { Theme };
export type ConcurrencyMode = 'adaptive' | 'manual';
export type ProcessState = 'queued' | 'processing' | 'ready' | 'error';

/** A resume prepared in History, handed off to the wizard's Upload step to run. */
export type PendingResume = {
  session: LoadedSession;
  attached: Map<string, File>;
  problems: ReconcileProblem[];
  generation: number;
};

/** A scanned file plus the results of P1 worker processing. */
export type FileEntry = ScannedFile & {
  processState: ProcessState;
  sha256?: string;
  exifNaive?: NaiveDateTime; // naive wall-clock components, no zone
  manualNaive?: NaiveDateTime; // user-entered wall-clock for files with no EXIF/container time
  exifCamera?: string;
  gps?: { lat: number; lon: number };
  width?: number;
  height?: number;
  thumbnail?: Blob;
  mimeType?: string; // worker-authoritative media type
  processError?: string;
  // Species the tagger applied before this batch was ever uploaded. Carried
  // opaquely: the uploader displays it read-only and emits it as observation
  // rows, and never edits it.
  preTags?: FlipObservation[];
};

type UploaderState = {
  s3Config: S3Config | null;
  connectionId: number; // increments on connect/disconnect to scope client-side caches
  section: Section;
  theme: Theme;
  elevationUnit: ElevationUnit; // display pref for location elevation (persisted)
  step: WizardStep;
  files: FileEntry[];
  validations: Record<string, FileValidation>;
  scanning: boolean;
  processing: boolean;
  batchToken: number; // bumps each new batch; identifies a processing run
  // A durable folder handle when the browser granted one (Chromium); drives the
  // resume access mode so a closed tab can re-read the same bytes.
  dirHandle: FileSystemDirectoryHandle | null;
  fileAccessMode: FileAccessMode;
  // Set once this batch has been round-tripped through the tagger; it is the
  // shared record's id, so "Edit tags" re-enters the same tagging session.
  flipId: string | null;
  uploaderUser: string; // free-text identity, normalized into a slug for keys
  selectedLocationKey: string | null; // chosen deployment location key (Assign)
  selectedBucket: string | null; // selected collection key `${bucket}::${uuid}` (Assign)
  uploadDescription: string; // free-text description for UploadMeta
  uploadTimeZone: string; // IANA zone EXIF naive times are interpreted in; default = browser zone
  dryRun: boolean; // off by default; when on, logs PUTs and writes nothing
  concurrencyMode: ConcurrencyMode; // adaptive tunes lanes during the run; manual pins them
  uploadConcurrency: number; // manual lane count, 4–32
  pendingResume: PendingResume | null; // prepared in History, consumed by the Upload step
  // Active upload run and its latest snapshot. Components subscribe to
  // activeSnap for display; the run lives here so disconnect() and App-level
  // beforeunload can reach it without depending on whichever component started
  // it, and so section navigation stops rendering a run rather than ending it.
  activeRun: UploadRun | StreamingUploadRun | null;
  // Streaming-only bridge ownership lives beside activeRun so installing a
  // resume/plain run cannot leave Inspect results targeting the prior run.
  streamingRun: StreamingUploadRun | null;
  streamingQueueClosed: boolean;
  activeSnap: UploadSnapshot | null;
  // Invalidated before cancellation so late callbacks from an obsolete run
  // cannot repopulate state or overwrite its replacement.
  activeRunGeneration: number;
  // Always 'upload': History prepares a resume and hands it to the wizard's
  // Upload step, which is the one surface that runs anything. Kept as a field
  // because disconnect and the beforeunload guard read it to tell a real run
  // from none.
  activeRunSource: 'upload' | null;
  activeRunReserved: boolean;
  // Folder recovery/hash verification happens before an UploadRun exists. Keep
  // its lock and progress here so leaving History cannot orphan the work and
  // expose Resume/Discard while the old component continues asynchronously.
  historyResumePreparation: {
    sessionId: string;
    progress: { done: number; total: number } | null;
  } | null;
  // Files reattached by a History handoff. Cleared alongside activeRun so a
  // completed or cancelled run doesn't hold stale File references. Used by
  // retryPartialRun so the App-level auto-resume effect can reach them without
  // needing Upload to be mounted.
  attachedFiles: Map<string, File> | null;

  connect: (config: S3Config, remember: boolean) => void;
  disconnect: () => void;
  setSection: (section: Section) => void;
  beginActiveRun: () => number | null;
  setActiveRun: (
    run: UploadRun | StreamingUploadRun,
    generation: number,
    streamingRun?: StreamingUploadRun,
  ) => void;
  closeStreamingQueue: (files: FileEntry[]) => void;
  setActiveSnap: (snap: UploadSnapshot, generation: number) => void;
  cancelActiveRun: () => void;
  clearActiveRun: () => void;
  beginHistoryResumePreparation: (sessionId: string) => void;
  setHistoryResumeProgress: (sessionId: string, done: number, total: number) => void;
  clearHistoryResumePreparation: (sessionId: string) => void;
  toggleTheme: () => void;
  setElevationUnit: (unit: ElevationUnit) => void;
  setStep: (step: WizardStep) => void;
  setScanning: (scanning: boolean) => void;
  setProcessing: (processing: boolean) => void;
  setFiles: (files: ScannedFile[], dirHandle?: FileSystemDirectoryHandle | null) => void;
  /** Adopt a batch coming back from the tagger, already reattached to real
   *  Files and already carrying its Inspect results — nothing to re-process. */
  adoptTaggedBatch: (input: {
    flipId: string;
    files: FileEntry[];
    dirHandle: FileSystemDirectoryHandle | null;
  }) => void;
  applyProgress: (started: string[], results: ProcessResponse[]) => void;
  revalidate: () => void;
  setThumbnail: (id: string, thumbnail: Blob) => void;
  removeFile: (id: string) => void;
  setManualNaive: (id: string, naive: NaiveDateTime | null) => void;
  resetBatch: () => void;
  setUploaderUser: (value: string) => void;
  setSelectedLocationKey: (key: string | null) => void;
  setSelectedBucket: (bucket: string | null) => void;
  setUploadDescription: (value: string) => void;
  setUploadTimeZone: (value: string) => void;
  setDryRun: (value: boolean) => void;
  setConcurrencyMode: (value: ConcurrencyMode) => void;
  setUploadConcurrency: (value: number) => void;
  setPendingResume: (value: PendingResume | null) => void;
  setAttachedFiles: (files: Map<string, File> | null) => void;
  retryPartialRun: () => Promise<void>;
  nextBatch: () => void;
};

function disconnectedState(s: UploaderState): Partial<UploaderState> {
  return {
    s3Config: null,
    connectionId: s.connectionId + 1,
    section: 'new',
    step: 'drop',
    files: [],
    validations: {},
    scanning: false,
    processing: false,
    batchToken: s.batchToken + 1,
    dirHandle: null,
    fileAccessMode: 'reselect-required',
    flipId: null,
    selectedLocationKey: null,
    selectedBucket: null,
    uploaderUser: '',
    uploadTimeZone: localTimeZone(),
    pendingResume: null,
    activeRun: null,
    streamingRun: null,
    streamingQueueClosed: false,
    activeSnap: null,
    activeRunGeneration: s.activeRunGeneration + 1,
    activeRunReserved: false,
    activeRunSource: null,
    historyResumePreparation: null,
    attachedFiles: null,
  };
}

function sameConnection(a: S3Config | null, b: S3Config): boolean {
  return !!a &&
    a.endpoint === b.endpoint &&
    a.region === b.region &&
    a.accessKey === b.accessKey &&
    a.secretKey === b.secretKey &&
    a.forcePathStyle === b.forcePathStyle &&
    a.secure === b.secure;
}

const toEntry = (f: ScannedFile): FileEntry => ({ ...f, processState: 'queued' });

// id -> index cache for `files`, so the high-frequency per-flush updates
// (applyProgress/setThumbnail, called every ~200ms and once per finished video
// poster during Inspect) can touch just the entries that changed instead of
// walking/rebuilding the whole array. Valid as long as the SET and ORDER of
// files hasn't changed — every call site that adds/removes/reorders files
// invalidates it; applyProgress/setThumbnail only overwrite existing slots, so
// they never need to.
let fileIndexById: Map<string, number> | null = null;
let retryPartialRunGeneration = 0;
let retryPartialRunPending: number | null = null;

function invalidateRetryPartialRun(): void {
  retryPartialRunGeneration++;
  retryPartialRunPending = null;
}

function invalidateFileIndex(): void {
  fileIndexById = null;
}

function getFileIndex(files: FileEntry[]): Map<string, number> {
  if (!fileIndexById) {
    fileIndexById = new Map();
    files.forEach((f, i) => fileIndexById!.set(f.id, i));
  }
  return fileIndexById;
}

// Read once at module init for the initial uploaderUser default below (the
// access key is non-secret, so it's safe to have persisted).
const initialPersisted = loadPersistedConnection();

// This tab's own session, if it has one — same tab, so a BrandSwitcher hop to
// another SPARC'd tool or a reload lands straight back in the app. Nothing is
// cached yet at module init, so unlike the cross-tab handler below this needs
// no cache clear and no connectionId bump.
const initialSession = loadSessionConnection();

const LEGACY_THEME_KEY = 'sparcd-uploader-session';

/** The choice this tool persisted for itself before the shared home existed. */
function legacyTheme(): Theme | null {
  try {
    const raw = sessionStorage.getItem(LEGACY_THEME_KEY);
    if (!raw) return null;
    const theme = (JSON.parse(raw) as { state?: { theme?: string } }).state?.theme;
    return theme === 'light' || theme === 'dark' ? theme : null;
  } catch {
    return null;
  }
}

function initialTheme(): Theme {
  const shared = loadSharedTheme();
  if (shared) return shared;
  const legacy = legacyTheme();
  if (legacy) saveSharedTheme(legacy);
  return legacy ?? 'light';
}

export const useStore = create<UploaderState>()(
  // The secret key never reaches localStorage — only the non-secret fields
  // (endpoint/access key/region/etc.) live there, to pre-fill the Connect form
  // on a machine with no session running. s3Config starts from this tab's own
  // sessionStorage session, so switching tools or reloading keeps the user in;
  // failing that, a sibling tab's live relay (`subscribeSharedConnection`)
  // supplies one within a message round-trip of mount, and otherwise the user
  // enters the secret. Zustand's own persist here covers cheap UI prefs
  // (elevationUnit — the theme lives in the shared home every SPARC'd tool
  // reads) plus the wizard's typed inputs and run options, so a reload doesn't
  // make a researcher retype the form; the in-flight batch (files, handles,
  // validations, step) is excluded too — it can't survive a reload anyway.
  persist(
    (set, get) => ({
      s3Config: initialSession,
      connectionId: 0,
      section: 'new',
      theme: initialTheme(),
      elevationUnit: 'meters',
      step: 'drop',
      files: [],
      validations: {},
      scanning: false,
      processing: false,
      batchToken: 0,
      dirHandle: null,
      fileAccessMode: 'reselect-required',
      flipId: null,
      // Defaults to the connected access key (the closest thing to a "login
      // name" this app has) — but only ever as a fill-in for blank; a value the
      // user typed or already had is never overwritten.
      uploaderUser: initialPersisted?.accessKey ?? '',
      selectedLocationKey: null,
      selectedBucket: null,
      uploadDescription: '',
      uploadTimeZone: localTimeZone(),
      dryRun: false,
      concurrencyMode: 'adaptive',
      uploadConcurrency: 8,
      pendingResume: null,
      activeRun: null,
      streamingRun: null,
      streamingQueueClosed: false,
      activeSnap: null,
      activeRunGeneration: 0,
      activeRunReserved: false,
      activeRunSource: null,
      historyResumePreparation: null,
      attachedFiles: null,

      connect: (config, remember) => {
        invalidateRetryPartialRun();
        clearClientCache();
        saveSharedConnection(config, remember);
        set((s) => ({
          s3Config: config,
          connectionId: s.connectionId + 1,
          selectedLocationKey: null,
          selectedBucket: null,
          uploaderUser: s.uploaderUser || config.accessKey,
        }));
      },
      disconnect: () => {
        invalidateRetryPartialRun();
        const run = get().activeRun;
        set((s) => disconnectedState(s));
        run?.cancel();
        clearClientCache();
        clearSharedConnection();
        invalidateFileIndex();
      },
      setSection: (section) => set({ section }),
      beginActiveRun: () => {
        if (get().activeRunReserved) return null;
        const generation = get().activeRunGeneration + 1;
        set({
          activeRun: null,
          streamingRun: null,
          streamingQueueClosed: false,
          activeSnap: null,
          activeRunGeneration: generation,
          activeRunReserved: true,
          activeRunSource: 'upload',
        });
        return generation;
      },
      setActiveRun: (run, generation, streamingRun) => {
        const state = get();
        if (state.activeRunGeneration !== generation || !state.activeRunReserved) {
          run.cancel();
          return;
        }
        set({
          activeRun: run,
          streamingRun: streamingRun ?? null,
          streamingQueueClosed: false,
          activeRunSource: 'upload',
        });
        if (streamingRun) {
          const releaseBridge = () => {
            // A replacement may have started before this run settled. Only
            // its own completion may release the bridge ownership.
            if (
              get().activeRunGeneration === generation &&
              get().streamingRun === streamingRun
            ) {
              set({ streamingRun: null, streamingQueueClosed: false });
            }
          };
          void streamingRun.done.then(releaseBridge, releaseBridge);
        }
      },
      closeStreamingQueue: (files) => {
        const { streamingRun, streamingQueueClosed } = get();
        if (!streamingRun || streamingQueueClosed) return;
        if (!processingComplete(files) || !captureTimeComplete(files)) return;
        // Latch before invoking close(): its queue can settle synchronously and
        // publish another store update, which must not close the run twice.
        set({ streamingQueueClosed: true });
        streamingRun.close(files);
      },
      setActiveSnap: (snap, generation) =>
        set((s) => {
          if (s.activeRunGeneration !== generation) return {};
          const terminal = snap.phase === 'done' || snap.phase === 'error' || snap.phase === 'partial';
          return terminal
            ? {
                activeSnap: snap,
                activeRun: null,
                streamingRun: null,
                streamingQueueClosed: false,
                activeRunReserved: false,
              }
            : { activeSnap: snap };
        }),
      cancelActiveRun: () => {
        const run = get().activeRun;
        set((s) => ({
          activeRun: null,
          streamingRun: null,
          streamingQueueClosed: false,
          activeSnap: null,
          activeRunGeneration: s.activeRunGeneration + 1,
          activeRunReserved: false,
          activeRunSource: null,
          attachedFiles: null,
        }));
        run?.cancel();
      },
      clearActiveRun: () =>
        set((s) => ({
          activeRun: null,
          streamingRun: null,
          streamingQueueClosed: false,
          activeSnap: null,
          activeRunGeneration: s.activeRunGeneration + 1,
          activeRunReserved: false,
          activeRunSource: null,
          attachedFiles: null,
        })),
      beginHistoryResumePreparation: (sessionId) =>
        set({ historyResumePreparation: { sessionId, progress: null } }),
      setHistoryResumeProgress: (sessionId, done, total) =>
        set((s) =>
          s.historyResumePreparation?.sessionId === sessionId
            ? { historyResumePreparation: { sessionId, progress: { done, total } } }
            : {},
        ),
      clearHistoryResumePreparation: (sessionId) =>
        set((s) =>
          s.historyResumePreparation?.sessionId === sessionId
            ? { historyResumePreparation: null }
            : {},
        ),
      toggleTheme: () =>
        set((s) => {
          const theme: Theme = s.theme === 'light' ? 'dark' : 'light';
          saveSharedTheme(theme);
          return { theme };
        }),
      setElevationUnit: (elevationUnit) => set({ elevationUnit }),
      setStep: (step) => set({ step }),
      setScanning: (scanning) => set({ scanning }),
      setProcessing: (processing) => set({ processing }),

      // De-dupe by relPath; a re-scan replaces the batch wholesale and bumps the
      // token so the processing controller starts a fresh run.
      setFiles: (scanned, dirHandle = null) => {
        const seen = new Set<string>();
        const entries = scanned
          .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
          .map(toEntry);
        invalidateFileIndex();
        set((s) => ({
          files: entries,
          validations: validateBatch(entries),
          step: entries.length > 0 ? 'inspect' : 'drop',
          batchToken: s.batchToken + 1,
          dirHandle,
          fileAccessMode: dirHandle ? 'persistent-handle' : 'reselect-required',
          flipId: null,
        }));
      },

      // Every file arrives `ready` with its hash, capture time, and thumbnail
      // already known — they were computed before the batch left for the tagger
      // and rode back in the shared record. `ensureProcessing` finds nothing
      // queued and idles, so Inspect renders instantly instead of re-hashing.
      adoptTaggedBatch: ({ flipId, files, dirHandle }) => {
        invalidateFileIndex();
        set((s) => ({
          files,
          validations: validateBatch(files),
          step: 'inspect' as const,
          batchToken: s.batchToken + 1,
          dirHandle,
          fileAccessMode: dirHandle ? 'persistent-handle' : 'reselect-required',
          flipId,
        }));
      },

      applyProgress: (started, results) => {
        if (started.length === 0 && results.length === 0) return;
        set((s) => {
          const index = getFileIndex(s.files);
          const files = s.files.slice();
          const validationUpdates: Record<string, FileValidation> = {};

          // Started-but-no-result-yet files just flip to "processing"; a file
          // that also has a result this same tick gets overwritten below with
          // its final state, so processing order here doesn't matter.
          for (const id of started) {
            const i = index.get(id);
            if (i === undefined) continue;
            const f = files[i];
            if (f.processState === 'queued') files[i] = { ...f, processState: 'processing' as const };
          }

          for (const result of results) {
            const i = index.get(result.id);
            if (i === undefined) continue;
            const f = files[i];
            const next: FileEntry = result.error
              ? { ...f, processState: 'error' as const, processError: result.error }
              : {
                  ...f,
                  processState: 'ready' as const,
                  sha256: result.sha256,
                  exifNaive: result.exifNaive,
                  exifCamera: result.exifCamera,
                  gps: result.gps,
                  width: result.width,
                  height: result.height,
                  thumbnail: result.thumbnail,
                  mimeType: result.mimeType,
                };
            files[i] = next;
            validationUpdates[result.id] = validateFile(next);
          }

          return { files, validations: { ...s.validations, ...validationUpdates } };
        });
      },

      revalidate: () => set((s) => ({ validations: validateBatch(s.files) })),

      // Attach a best-effort poster after the fact (video frames are captured on
      // the main thread, post-worker). No validation re-run: a poster never
      // changes a verdict.
      setThumbnail: (id, thumbnail) =>
        set((s) => {
          const i = getFileIndex(s.files).get(id);
          if (i === undefined) return {};
          const files = s.files.slice();
          files[i] = { ...files[i], thumbnail };
          return { files };
        }),

      removeFile: (id) =>
        set((s) => {
          const files = s.files.filter((f) => f.id !== id);
          invalidateFileIndex();
          return { files, validations: validateBatch(files) };
        }),

      // Manual capture time for a file with no EXIF/container time. Stored as raw
      // naive components (like exifNaive) so it's interpreted in the upload zone
      // at bundle build; null clears it and re-surfaces the file as unset.
      setManualNaive: (id, naive) =>
        set((s) => {
          const files = s.files.map((f) =>
            f.id === id ? { ...f, manualNaive: naive ?? undefined } : f,
          );
          return { files, validations: validateBatch(files) };
        }),

      resetBatch: () => {
        invalidateRetryPartialRun();
        invalidateFileIndex();
        set((s) => ({
          files: [],
          validations: {},
          step: 'drop',
          batchToken: s.batchToken + 1,
          dirHandle: null,
          fileAccessMode: 'reselect-required',
          flipId: null,
          activeRun: null,
          streamingRun: null,
          streamingQueueClosed: false,
          activeSnap: null,
          activeRunGeneration: s.activeRunGeneration + 1,
          activeRunReserved: false,
          activeRunSource: null,
          historyResumePreparation: null,
          attachedFiles: null,
        }));
      },

      // Stored raw; sanitizeUploaderUser derives the key-safe slug at point of use.
      setUploaderUser: (value) => set({ uploaderUser: value }),
      setSelectedLocationKey: (key) => set({ selectedLocationKey: key }),
      setSelectedBucket: (bucket) => set({ selectedBucket: bucket }),
      setUploadDescription: (value) => set({ uploadDescription: value }),
      setUploadTimeZone: (value) => set({ uploadTimeZone: value }),
      setDryRun: (value) => set({ dryRun: value }),
      setConcurrencyMode: (value) => set({ concurrencyMode: value }),
      setUploadConcurrency: (value) => set({ uploadConcurrency: value }),
      setPendingResume: (value) => set({ pendingResume: value }),
      setAttachedFiles: (files) => set({ attachedFiles: files }),
      retryPartialRun: async () => {
        if (retryPartialRunPending !== null) return;
        const { s3Config, connectionId, activeSnap, attachedFiles, files } = get();
        if (!s3Config || activeSnap?.phase !== 'partial' || activeSnap.dryRun) return;
        const attempt = ++retryPartialRunGeneration;
        retryPartialRunPending = attempt;
        try {
          const session = await loadSession(activeSnap.sessionId);
          const current = get();
          if (
            retryPartialRunGeneration !== attempt ||
            current.connectionId !== connectionId ||
            current.s3Config !== s3Config ||
            current.activeSnap !== activeSnap
          ) return;
          // Guard: no bundle means a systemic-abort run that needs ensureBundle;
          // that path requires the files still in memory and lives in Upload.tsx.
          if (!session?.bundle) return;
          const attached = attachedFiles ?? new Map(files.map((f) => [f.relPath, f.file]));
          const concurrency =
            get().concurrencyMode === 'manual'
              ? { mode: 'manual' as const, get: () => get().uploadConcurrency }
              : { mode: 'adaptive' as const };
          const generation = get().beginActiveRun();
          if (generation === null) return;
          const run = resumeUpload(
            { config: s3Config, session, attached, concurrency },
            (next) => get().setActiveSnap(next, generation),
          );
          get().setActiveRun(run, generation);
        } catch {
          // Transient IDB or resume error — leave phase as 'partial' so the
          // next visibility or online event can try again. Permanent failures
          // are surfaced by the manual Retry button in Upload.tsx, which has
          // its own error display.
        } finally {
          if (retryPartialRunPending === attempt) retryPartialRunPending = null;
        }
      },

      // Start a fresh batch after a completed upload, keeping the deployment,
      // uploader, target collection, and description so a researcher can chain
      // batches for the same site without re-entering everything.
      nextBatch: () => {
        invalidateRetryPartialRun();
        invalidateFileIndex();
        set((s) => ({
          files: [],
          validations: {},
          step: 'drop',
          batchToken: s.batchToken + 1,
          dirHandle: null,
          fileAccessMode: 'reselect-required',
          flipId: null,
          activeRun: null,
          streamingRun: null,
          streamingQueueClosed: false,
          activeSnap: null,
          activeRunGeneration: s.activeRunGeneration + 1,
          activeRunReserved: false,
          activeRunSource: null,
          historyResumePreparation: null,
          attachedFiles: null,
        }));
      },
    }),
    {
      name: 'sparcd-uploader-session',
      storage: createJSONStorage(() => sessionStorage),
      // Assign's controls (deployment, collection, uploader identity,
      // timezone, description) are plain strings — safe to persist, unlike
      // files/handles — and nextBatch() already keeps them in memory across
      // batches with exactly this in mind; this just makes that survive a
      // reload too. A stale selectedLocationKey/selectedBucket from a
      // different connection is harmless: Assign already clears/reselects
      // either one when it doesn't match the connected backend's data. The run
      // options ride along for the same reason.
      partialize: (s) => ({
        elevationUnit: s.elevationUnit,
        uploaderUser: s.uploaderUser,
        selectedLocationKey: s.selectedLocationKey,
        selectedBucket: s.selectedBucket,
        uploadDescription: s.uploadDescription,
        uploadTimeZone: s.uploadTimeZone,
        dryRun: s.dryRun,
        concurrencyMode: s.concurrencyMode,
        uploadConcurrency: s.uploadConcurrency,
      }),
    },
  ),
);

// React to login/logout in OTHER tabs open right now, live (never persisted —
// see session.ts). Mirror the new connection into this store and bump
// connectionId so client-side caches scoped to a connection are invalidated.
// Also answers a sibling tab's own request with our current s3Config, if any.
subscribeSharedConnection((cfg) => {
  const current = useStore.getState();
  // A sibling tab can rebroadcast the exact same session while answering a
  // connection request. That is not a replacement and must not cancel work.
  if (cfg && sameConnection(current.s3Config, cfg)) return;
  clearClientCache();
  const replacingConnection = !!cfg && !!current.s3Config && !sameConnection(current.s3Config, cfg);
  if (!cfg || replacingConnection) {
    invalidateFileIndex();
    const run = current.activeRun;
    useStore.setState((s) => ({
      ...disconnectedState(s),
      ...(cfg ? { s3Config: cfg, uploaderUser: cfg.accessKey } : {}),
    }));
    run?.cancel();
    return;
  }
  useStore.setState((s) => ({
    s3Config: cfg,
    connectionId: s.connectionId + 1,
    uploaderUser: s.uploaderUser || cfg.accessKey,
  }));
}, () => useStore.getState().s3Config);
