import type { FileEntry } from '../store';
import { partsInZone, type NaiveDateTime } from './exifTime';

export type EstimateMethod = 'interpolated' | 'offset' | 'file-modified';
/** What estimation reads off a file — a `FileEntry`, or a resumed ledger row
 *  paired with its reattached source file. */
export type EstimateInput = Pick<FileEntry, 'id' | 'relPath' | 'processState' | 'exifNaive'> & {
  file: { lastModified: number };
};
export type CaptureEstimate = {
  naive: NaiveDateTime;
  method: EstimateMethod;
  before?: string;
  after?: string;
  /** Minutes between an `offset` estimate and its reference file's camera time. */
  offsetMinutes?: number;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalPathCompare = (a: string, b: string): number => collator.compare(a, b);

export const naiveMillis = (n: NaiveDateTime): number =>
  Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);

export function naiveFromMillis(ms: number): NaiveDateTime {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
}

export function estimateCaptureTimes(files: EstimateInput[], timeZone: string): Map<string, CaptureEstimate> {
  const ordered = files.filter((f) => f.processState === 'ready')
    .sort((a, b) => naturalPathCompare(a.relPath, b.relPath));
  const estimates = new Map<string, CaptureEstimate>();
  let previous: EstimateInput | undefined;
  let start = 0;
  while (start < ordered.length) {
    if (ordered[start].exifNaive) {
      previous = ordered[start++];
      continue;
    }
    let end = start;
    while (end < ordered.length && !ordered[end].exifNaive) end++;
    const next = ordered[end];
    const p = previous?.exifNaive ? naiveMillis(previous.exifNaive) : undefined;
    const n = next?.exifNaive ? naiveMillis(next.exifNaive) : undefined;
    for (let j = start; j < end; j++) {
      const f = ordered[j];
      const i = j - start + 1;
      const k = end - start;
      let estimate: CaptureEstimate;
      if (p !== undefined && n !== undefined && p <= n) {
        estimate = { naive: naiveFromMillis(p + i * (n - p) / (k + 1)), method: 'interpolated', before: previous!.relPath, after: next.relPath };
      } else if (p !== undefined && n === undefined) {
        const delta = 600_000 * i;
        estimate = { naive: naiveFromMillis(p + delta), method: 'offset', before: previous!.relPath, offsetMinutes: delta / 60_000 };
      } else if (p === undefined && n !== undefined) {
        const delta = 600_000 * (k + 1 - i);
        estimate = { naive: naiveFromMillis(n - delta), method: 'offset', after: next.relPath, offsetMinutes: delta / 60_000 };
      } else {
        estimate = { naive: partsInZone(f.file.lastModified, timeZone), method: 'file-modified' };
      }
      estimates.set(f.id, estimate);
    }
    start = end;
  }
  return estimates;
}
