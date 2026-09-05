import { describe, it, expect } from 'vitest';
import { estimateCaptureTimes } from '../src/lib/estimateCaptureTime';
import { formatNaive, inputValueToNaive } from '../src/lib/exifTime';
import type { FileEntry } from '../src/store';

const file = (id: string, time?: string, over: Partial<FileEntry> = {}): FileEntry => ({
  id, relPath: id, fileName: id, size: 1, mediaKind: 'image', processState: 'ready',
  file: new File(['x'], id, { lastModified: Date.parse('2024-01-10T07:30:45Z') }),
  exifNaive: time ? inputValueToNaive(time)! : undefined, ...over,
});
const time = (minute: string) => `2024-01-10T08:${minute}:00`;
const values = (files: FileEntry[], zone = 'UTC') =>
  [...estimateCaptureTimes(files, zone).values()].map((e) => formatNaive(e.naive));

describe('estimateCaptureTimes', () => {
  it('interpolates a midpoint and records both references even with a manual override', () => {
    const files = [file('1', time('00')), file('2', undefined, { manualNaive: inputValueToNaive(time('50'))! }), file('3', time('10'))];
    expect(estimateCaptureTimes(files, 'UTC').get('2')).toEqual({
      naive: inputValueToNaive(time('05')), method: 'interpolated', before: '1', after: '3',
    });
  });
  it('spreads three missing times evenly and truncates fractional seconds', () => {
    expect(values([file('1', time('00')), file('2'), file('3'), file('4'), file('5', time('04'))]))
      .toEqual(['01', '02', '03'].map(time));
    expect(values([file('1', time('00')), file('2'), file('3', '2024-01-10T08:00:03')]))
      .toEqual(['2024-01-10T08:00:01']);
  });
  it.each(['previous', 'next'])('offsets three files from only the %s reference', (side) => {
    const files = side === 'previous'
      ? [file('1', time('00')), file('2'), file('3'), file('4')]
      : [file('1'), file('2'), file('3'), file('4', time('40'))];
    const estimates = [...estimateCaptureTimes(files, 'UTC').values()];
    expect(estimates.map((e) => formatNaive(e.naive))).toEqual(['10', '20', '30'].map(time));
    for (const e of estimates) expect(e).toMatchObject(side === 'previous'
      ? { method: 'offset', before: '1' } : { method: 'offset', after: '4' });
    // Each one reports its own distance from the reference, not a flat 10.
    expect(estimates.map((e) => e.offsetMinutes)).toEqual(side === 'previous' ? [10, 20, 30] : [30, 20, 10]);
  });
  it('uses file modification time for an entire inverted run without references', () => {
    const estimates = estimateCaptureTimes([file('1', time('20')), file('2'), file('3'), file('4', time('00'))], 'America/Phoenix');
    for (const e of estimates.values()) expect(e).toEqual({ naive: inputValueToNaive('2024-01-10T00:30:45'), method: 'file-modified' });
  });
  it('renders modification times in Phoenix when there are no references', () => {
    expect(values([file('1')], 'America/Phoenix')).toEqual(['2024-01-10T00:30:45']);
  });
  it('uses natural order and leaves input order untouched', () => {
    const files = [file('IMG_10'), file('IMG_9', time('00')), file('IMG_11', time('20'))];
    expect(values(files)).toEqual([time('10')]);
    expect(files[0].id).toBe('IMG_10');
  });
  it('ignores non-ready files and keeps original order for equal paths', () => {
    expect(values([file('1', time('00'), { processState: 'queued' }), file('2'), file('3', time('20'), { processState: 'error' })]))
      .toEqual(['2024-01-10T07:30:45']);
    expect(values([file('a', time('00')), file('A'), file('b', time('20'))])).toEqual([time('10')]);
  });
  it('keeps wall-clock interpolation linear across a DST change', () => {
    expect(values([file('1', '2024-03-10T01:00:00'), file('2'), file('3', '2024-03-10T04:00:00')], 'America/New_York'))
      .toEqual(['2024-03-10T02:30:00']);
  });
});
