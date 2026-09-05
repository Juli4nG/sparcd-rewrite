// One batch out to the tagger and back, through the real hand-off code on both
// sides. The four ways a file can get its capture time — the camera's own, one
// typed in, one spread, and one estimated — have to survive the round trip and
// land in media.csv saying where they came from, because the flip record is the
// only thing that carries them: there is no second Inspect pass on the way home.

import { beforeAll, expect, it, vi } from 'vitest';
import type { FlipRecord } from '@sparcd/flip';
import type { NaiveDateTime } from '../src/lib/exifTime';
import type { FileEntry } from '../src/store';

const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
(globalThis as any).window = Object.assign(globalThis, {
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: storage(),
  sessionStorage: storage(),
  location: { href: '', search: '' },
});

// The hand-off's transport is IndexedDB, which node has none of; everything
// else in the package — `captureTimestampOf` above all — is the real thing.
const stored = vi.hoisted(() => ({ record: undefined as FlipRecord | undefined }));
vi.mock('@sparcd/flip', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sparcd/flip')>()),
  writeFlipRecord: async (r: FlipRecord) => void (stored.record = r),
  readFlipRecord: async () => stored.record,
}));
// resume.ts pulls in the worker pool; nothing here hashes anything.
vi.mock('../src/lib/processPool', () => ({ processBatch: vi.fn() }));

let useStore: typeof import('../src/store')['useStore'];
let handOffToTagger: typeof import('../src/lib/flip')['handOffToTagger'];
let resumeFromFlip: typeof import('../src/lib/flip')['resumeFromFlip'];
let buildBundle: typeof import('../src/lib/bundle')['buildBundle'];
let captureTimestampOf: typeof import('@sparcd/flip')['captureTimestampOf'];

beforeAll(async () => {
  ({ useStore } = await import('../src/store'));
  ({ handOffToTagger, resumeFromFlip } = await import('../src/lib/flip'));
  ({ buildBundle } = await import('../src/lib/bundle'));
  ({ captureTimestampOf } = await import('@sparcd/flip'));
});

const at = (hour: number, minute: number): NaiveDateTime => ({ year: 2026, month: 7, day: 1, hour, minute, second: 0 });

const SIZE = 64;
const entry = (name: string, over: Partial<FileEntry>): FileEntry =>
  ({
    id: `trip/${name}`,
    relPath: `trip/${name}`,
    fileName: name,
    size: SIZE,
    mediaKind: 'image',
    processState: 'ready',
    sha256: `sha-${name}`,
    mimeType: 'image/jpeg',
    file: new File([new Uint8Array(SIZE)], name, { type: 'image/jpeg' }),
    ...over,
  }) as FileEntry;

const NAMES = ['1-camera.jpg', '2-manual.jpg', '3-spread.jpg', '4-none.jpg'];

// A folder that still holds all four files, so the trusted restore reattaches
// every one of them by path + size.
const dirHandle = () =>
  ({
    kind: 'directory',
    name: 'trip',
    values: async function* () {
      for (const name of NAMES) {
        yield {
          kind: 'file' as const,
          name,
          getFile: async () => new File([new Uint8Array(SIZE)], name, { type: 'image/jpeg' }),
        };
      }
    },
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
  }) as unknown as FileSystemDirectoryHandle;

const UUID = '8dbd9c43-5c3d-411d-8778-617d4693c69b';

/** The `comments` column of the media.csv row for one file — every field is
 *  quoted and comments is the last one. */
const commentsFor = (csv: string, fileName: string): string =>
  csv
    .split('\n')
    .find((line) => line.includes(`"${fileName}"`))!
    .split(',')
    .pop()!
    .replace(/"/g, '');

it('carries every kind of capture time out to the tagger and home into media.csv', async () => {
  useStore.setState({
    uploadTimeZone: 'UTC',
    dirHandle: dirHandle(),
    files: [
      entry('1-camera.jpg', { exifNaive: at(12, 0) }),
      entry('2-manual.jpg', { manualNaive: at(12, 5), manualSource: 'manual' }),
      entry('3-spread.jpg', { manualNaive: at(12, 6), manualSource: 'spread' }),
      entry('4-none.jpg', {}),
    ],
  });

  await handOffToTagger();
  const record = stored.record!;
  expect(record.files.map((f) => f.relPath)).toEqual(NAMES.map((n) => `trip/${n}`));
  // Only file with no time of its own: 30 minutes past the one camera time,
  // three ten-minute steps down the gap it opens.
  expect(captureTimestampOf(record.files[3])).toBe('2026-07-01T12:30:00');

  useStore.setState({ files: [], dirHandle: null });
  expect(await resumeFromFlip(record.id)).toEqual({ kind: 'restored' });

  const bundle = await buildBundle({
    location: { key: 'SAN15|31.5,-110.2', id: 'SAN15', name: 'San Pedro 15', latitude: 31.5, longitude: -110.2, elevation: 1200 },
    collectionUuid: UUID,
    bucket: `sparcd-${UUID}`,
    uploaderSlug: 'jdoe',
    description: 'july',
    timeZone: 'UTC',
    files: useStore.getState().files,
    now: new Date('2026-07-02T10:00:00.000Z'),
  });

  expect(commentsFor(bundle.mediaCsv, '1-camera.jpg')).toBe('');
  expect(commentsFor(bundle.mediaCsv, '2-manual.jpg')).toBe('[TIMESTAMP:manual]');
  expect(commentsFor(bundle.mediaCsv, '3-spread.jpg')).toBe('[TIMESTAMP:spread]');
  expect(commentsFor(bundle.mediaCsv, '4-none.jpg')).toBe('[TIMESTAMP:offset]');
  expect(bundle.mediaCsv).toContain('2026-07-01T12:30:00.000Z');
  expect(bundle.deploymentsCsv.split(',')[15]).toBe('"true"'); // timestamp_issues
});
