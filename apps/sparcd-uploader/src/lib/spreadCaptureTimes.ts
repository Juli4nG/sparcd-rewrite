import type { FileEntry } from '../store';
import { partsInZone, type NaiveDateTime } from './exifTime';
import { naturalPathCompare, naiveMillis, naiveFromMillis } from './estimateCaptureTime';

export type SpreadOptions =
  | { kind: 'sequence'; start: NaiveDateTime; spacingSeconds: number }
  | { kind: 'file-modified'; timeZone: string };

export function spreadCaptureTimes(files: FileEntry[], opts: SpreadOptions): Map<string, NaiveDateTime> {
  return new Map([...files].sort((a, b) => naturalPathCompare(a.relPath, b.relPath)).map((f, i) => [
    f.id,
    opts.kind === 'sequence'
      ? naiveFromMillis(naiveMillis(opts.start) + i * opts.spacingSeconds * 1000)
      : partsInZone(f.file.lastModified, opts.timeZone),
  ]));
}
