import { it, expect } from 'vitest';
import { spreadCaptureTimes } from '../src/lib/spreadCaptureTimes';
import { formatNaive, inputValueToNaive } from '../src/lib/exifTime';
import type { FileEntry } from '../src/store';

const files = ['IMG_10', 'IMG_9'].map((id): FileEntry => ({
  id, relPath: id, fileName: id, size: 1, mediaKind: 'image', processState: 'ready',
  file: new File(['x'], id, { lastModified: Date.parse('2024-01-10T07:30:45Z') }),
}));
it('spreads a naturally sorted sequence across midnight', () => {
  const result = spreadCaptureTimes(files, { kind: 'sequence', start: inputValueToNaive('2024-01-10T23:59:30')!, spacingSeconds: 60 });
  expect([...result].map(([id, n]) => [id, formatNaive(n)])).toEqual([
    ['IMG_9', '2024-01-10T23:59:30'], ['IMG_10', '2024-01-11T00:00:30'],
  ]);
  expect(files[0].id).toBe('IMG_10');
});
it('uses each file modification time in the requested zone', () => {
  expect([...spreadCaptureTimes(files, { kind: 'file-modified', timeZone: 'America/Phoenix' }).values()].map(formatNaive))
    .toEqual(['2024-01-10T00:30:45', '2024-01-10T00:30:45']);
});
