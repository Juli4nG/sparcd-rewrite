// Module-level bridge between the Inspect worker pool and a live streaming run.
// Lives outside any React component so it survives section navigation — the
// run keeps receiving newly-inspected files and the queue closes correctly even
// when the user is on the History or Settings section while a run is in flight.

import { onFilesReady } from './processing';
import { processingComplete } from './validation';
import { useStore } from '../store';
import type { StreamingUploadRun } from './upload';
import type { FileEntry } from '../store';

export function maybeCloseStreamingQueue(files: FileEntry[]): void {
  const { streamingRun, streamingQueueClosed, closeStreamingQueue } = useStore.getState();
  if (!streamingRun || streamingQueueClosed) return;
  if (processingComplete(files)) {
    closeStreamingQueue(files);
  }
}

// Feed newly-inspected files into the live run. Registered once at module load;
// never torn down, so navigation doesn't break the bridge.
export function forwardReadyToStreamingRun(results: { id: string }[]): void {
  const streamingRun: StreamingUploadRun | null = useStore.getState().streamingRun;
  if (!streamingRun) return;
  const ids = new Set(results.map((r) => r.id));
  const current = useStore.getState().files;
  const arrived = current.filter((f) => ids.has(f.id) && f.processState === 'ready' && f.sha256);
  if (arrived.length > 0) streamingRun.notifyReady(arrived);
}

onFilesReady(forwardReadyToStreamingRun);

// Close the queue when the batch finishes inspection, regardless of which
// section is on screen.
useStore.subscribe((state, prev) => {
  if (state.files !== prev.files) maybeCloseStreamingQueue(state.files);
});
