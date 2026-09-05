import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileEntry } from '../src/store';
import { inputValueToNaive } from '../src/lib/exifTime';
import { CaptureTimeEditor, sequenceSpread } from '../src/components/CaptureTimeEditor';

const state = vi.hoisted(() => ({
  files: [] as FileEntry[], uploadTimeZone: 'UTC',
  setManualNaive: vi.fn(), setManualNaiveMany: vi.fn(),
}));
vi.mock('../src/store', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));

const at = (v: string) => inputValueToNaive(v)!;

/** `cameras` are camera times by index; every other file has none. */
const batch = (count: number, cameras: Record<number, string>, manual: Record<number, string> = {}) => {
  state.files = Array.from({ length: count }, (_, i) => {
    const id = `${i}.jpg`;
    return {
      id, relPath: id, fileName: id, size: 1, mediaKind: 'image', processState: 'ready',
      file: new File(['x'], id),
      exifNaive: cameras[i] ? at(cameras[i]) : undefined,
      manualNaive: manual[i] ? at(manual[i]) : undefined,
    } as FileEntry;
  });
  return renderToStaticMarkup(<CaptureTimeEditor files={state.files} />);
};

// Ten minutes past the last camera time is where an offset belongs, so it
// clamps to the end of the bar instead of stretching it — and it is not a
// problem worth flagging.
it('clamps the offsets to the ends of the camera range without flagging them', () => {
  const html = batch(4, { 1: '2026-07-01T12:00:00', 2: '2026-07-01T12:10:00' });
  expect(html).not.toContain('outside the camera-time range.');
  expect(html).toContain('Interpolated times sit between their neighbours');
  expect(html).toMatch(/bg-warn" style="left:0%;opacity:1"/);
  expect(html).toMatch(/bg-warn" style="left:100%;opacity:1"/);
  // The camera times still hold the full width of the bar.
  expect(html).toMatch(/bg-accent" style="left:0%;opacity:1"/);
  expect(html).toMatch(/bg-accent" style="left:100%;opacity:1"/);
});

it('flags a hand-set time outside the camera-time range and keeps the bar on the cameras', () => {
  const html = batch(3, { 0: '2026-07-01T12:00:00', 2: '2026-07-01T12:10:00' }, { 1: '2020-01-01T00:00:00' });
  expect(html).toContain('1 lands outside the camera-time range.');
  expect(html).toMatch(/bg-accent" style="left:0%;opacity:1"/);
  expect(html).toMatch(/bg-accent" style="left:100%;opacity:1"/);
  // Six years early, drawn at the near end rather than squashing the cameras.
  expect(html).toMatch(/bg-warn" style="left:0%;opacity:1"/);
});

// Both spread fields are the user's to empty, and an empty one has no sensible
// substitute — Apply and the summary line wait for a value rather than guess.
describe('sequenceSpread', () => {
  const start = '2026-07-01T09:00:00';

  it('describes the spread once both fields parse', () => {
    expect(sequenceSpread(start, '30')).toEqual({ kind: 'sequence', start: at(start), spacingSeconds: 30 });
  });

  it('gives nothing while the first-image time is empty', () => {
    expect(sequenceSpread('', '30')).toBeUndefined();
  });

  it.each(['', '0', 'abc'])('gives nothing for a spacing of %o', (spacing) => {
    expect(sequenceSpread(start, spacing)).toBeUndefined();
  });
});
