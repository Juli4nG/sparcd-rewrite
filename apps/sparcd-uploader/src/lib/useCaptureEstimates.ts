// The display side of the capture-time rule. `estimateCaptureTimes` is the same
// pure function the bundle build runs, so what Inspect and Assign show is what
// media.csv will carry: EXIF, else a hand/spread override, else the estimate.

import { useMemo } from 'react';
import type { TimestampSource } from '@sparcd/camtrap';
import { useStore, type FileEntry } from '../store';
import { estimateCaptureTimes, type CaptureEstimate } from './estimateCaptureTime';
import { formatNaive, type NaiveDateTime } from './exifTime';

export function useCaptureEstimates(): Map<string, CaptureEstimate> {
  const files = useStore((s) => s.files);
  const uploadTimeZone = useStore((s) => s.uploadTimeZone);
  return useMemo(() => estimateCaptureTimes(files, uploadTimeZone), [files, uploadTimeZone]);
}

/** The time this file will be published with, and where it came from. `source`
 *  is undefined only for a camera-written time. `naive` is undefined only while
 *  a file is still queued or processing — the estimate map covers ready files. */
export function effectiveTime(
  f: FileEntry,
  estimates: Map<string, CaptureEstimate>,
): { naive?: NaiveDateTime; source?: TimestampSource } {
  if (f.exifNaive) return { naive: f.exifNaive };
  if (f.manualNaive) return { naive: f.manualNaive, source: f.manualSource ?? 'manual' };
  const estimate = estimates.get(f.id);
  return { naive: estimate?.naive, source: estimate?.method };
}

const TAGS: Record<TimestampSource, string> = {
  interpolated: 'EST.',
  offset: 'EST.',
  'file-modified': 'EST.',
  manual: 'MANUAL',
  spread: 'SPREAD',
};

export const sourceTag = (source: TimestampSource): string => TAGS[source];

const baseName = (relPath: string): string => relPath.split('/').pop() ?? relPath;

const shortNaive = (n: NaiveDateTime): string => formatNaive(n).replace('T', ' ');

/** Earliest spread time in the batch — the start a Spread was applied from. */
export function spreadStartOf(files: FileEntry[]): NaiveDateTime | undefined {
  return files
    .filter((f) => f.manualSource === 'spread' && f.manualNaive)
    .map((f) => f.manualNaive!)
    .sort((a, b) => formatNaive(a).localeCompare(formatNaive(b)))[0];
}

/** One line saying how this file's time was arrived at. */
export function methodLine(
  f: FileEntry,
  estimate: CaptureEstimate | undefined,
  timeZone: string,
  spreadStart?: NaiveDateTime,
): string {
  if (f.exifNaive) return 'camera time';
  if (f.manualNaive) {
    return f.manualSource === 'spread' && spreadStart
      ? `spread from ${shortNaive(spreadStart)}`
      : 'set by hand';
  }
  if (!estimate) return '';
  if (estimate.method === 'interpolated')
    return `between ${baseName(estimate.before!)} and ${baseName(estimate.after!)}`;
  if (estimate.method === 'offset')
    return estimate.before
      ? `${estimate.offsetMinutes} min after ${baseName(estimate.before)} (last file)`
      : `${estimate.offsetMinutes} min before ${baseName(estimate.after!)} (first file)`;
  return `file modified time (${timeZone})`;
}
