// The hand-off record's contract: a round trip preserves the batch, and the
// merge helpers only ever touch the images they were handed. Runs against
// fake-indexeddb, so it exercises the real Dexie schema — Blobs and directory
// handles are left out because Node has nothing to structured-clone them from.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  flipDb,
  mergeTags,
  captureTimestampOf,
  writeFlipRecord,
  readFlipRecord,
  deleteFlipRecord,
  pruneFlipRecords,
  updateFlipTags,
  finishFlipRecord,
  type FlipFile,
  type FlipObservation,
  type FlipRecord,
} from '../src/index';

const coyote: FlipObservation = {
  scientificName: 'Canis latrans',
  commonName: 'Coyote',
  count: 2,
  requestedSpecies: '',
  freeTags: '',
};

const ghost: FlipObservation = {
  scientificName: 'Casper',
  commonName: 'Ghost',
  count: 1,
  requestedSpecies: '',
  freeTags: '',
};

/** A file carrying everything the uploader's Inspect pass establishes. */
const inspected = (over: Partial<FlipFile> = {}): FlipFile => ({
  relPath: 'SD/IMG_0001.JPG',
  fileName: 'IMG_0001.JPG',
  size: 100,
  sha256: 'aa',
  mediaKind: 'image',
  exifTimestamp: '2026-07-01T12:00:00',
  mimeType: 'image/jpeg',
  exifCamera: 'RECONYX HP2X',
  gps: { lat: 31.5, lon: -110.2 },
  width: 2048,
  height: 1536,
  ...over,
});

const record = (over: Partial<FlipRecord> = {}): FlipRecord => ({
  id: 'batch-1',
  v: 1,
  createdAt: '2026-08-25T10:00:00.000Z',
  returnUrl: '/sparcd-exploration/uploader/?flip=batch-1',
  files: [inspected(), { ...inspected(), relPath: 'SD/IMG_0002.JPG', fileName: 'IMG_0002.JPG' }],
  tags: {},
  ...over,
});

beforeEach(async () => {
  await flipDb.records.clear();
});

describe('mergeTags', () => {
  it('leaves images the partial does not mention alone', () => {
    const merged = mergeTags({ a: [coyote], b: [ghost] }, { a: [ghost] });
    expect(merged).toEqual({ a: [ghost], b: [ghost] });
  });

  it('treats an empty array as a real value — a detagged image', () => {
    expect(mergeTags({ a: [coyote] }, { a: [] })).toEqual({ a: [] });
  });
});

describe('capture time', () => {
  it('shows the time the camera wrote when there is one', () => {
    expect(captureTimestampOf(inspected())).toBe('2026-07-01T12:00:00');
  });

  it('falls back to a time entered by hand', () => {
    const f = inspected({ exifTimestamp: undefined, manualTimestamp: '2026-07-01T09:30:00' });
    expect(captureTimestampOf(f)).toBe('2026-07-01T09:30:00');
  });

  it('prefers the camera over a stray manual entry, as the bundle does', () => {
    expect(captureTimestampOf(inspected({ manualTimestamp: '2020-01-01T00:00:00' }))).toBe(
      '2026-07-01T12:00:00',
    );
  });

  it('is absent for a file with neither', () => {
    expect(captureTimestampOf(inspected({ exifTimestamp: undefined }))).toBeUndefined();
  });
});

describe('the record round trip', () => {
  it('reads back everything the uploader wrote', async () => {
    await writeFlipRecord(record());
    const back = await readFlipRecord('batch-1');
    expect(back).toEqual(record());
  });

  // The batch is rebuilt from this record on the way back, and there is no
  // second Inspect pass — a field that does not survive the round trip is a
  // field the uploader has to publish without.
  it('keeps every result Inspect established, not just what draws a tile', async () => {
    await writeFlipRecord(record());
    const [file] = (await readFlipRecord('batch-1'))!.files;
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.exifCamera).toBe('RECONYX HP2X');
    expect(file.gps).toEqual({ lat: 31.5, lon: -110.2 });
    expect(file.width).toBe(2048);
    expect(file.height).toBe(1536);
  });

  it('keeps a hand-entered time in its own slot, never in the camera one', async () => {
    const manual = inspected({ exifTimestamp: undefined, manualTimestamp: '2026-07-01T09:30:00' });
    await writeFlipRecord(record({ files: [manual] }));
    const [file] = (await readFlipRecord('batch-1'))!.files;
    expect(file.exifTimestamp).toBeUndefined();
    expect(file.manualTimestamp).toBe('2026-07-01T09:30:00');
  });

  it('is absent for an id nobody wrote', async () => {
    expect(await readFlipRecord('nope')).toBeUndefined();
  });

  it('reports a record from a schema it does not know as absent', async () => {
    await flipDb.records.put({ ...record(), v: 2 } as unknown as FlipRecord);
    expect(await readFlipRecord('batch-1')).toBeUndefined();
  });
});

describe('not keeping batches forever', () => {
  it('deletes a record outright', async () => {
    await writeFlipRecord(record());
    await deleteFlipRecord('batch-1');
    expect(await readFlipRecord('batch-1')).toBeUndefined();
  });

  it('sweeps up hand-offs nobody came back for', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z').toISOString();
    await writeFlipRecord(record({ id: 'stale', createdAt: old }));
    await writeFlipRecord(record({ id: 'fresh', createdAt: new Date().toISOString() }));
    const removed = await pruneFlipRecords();
    expect(removed).toBe(1);
    expect(await readFlipRecord('stale')).toBeUndefined();
    expect(await readFlipRecord('fresh')).toBeDefined();
  });

  it('keeps a batch that is merely a fortnight old', async () => {
    const now = Date.parse('2026-08-25T00:00:00.000Z');
    const fortnight = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    await writeFlipRecord(record({ createdAt: fortnight }));
    expect(await pruneFlipRecords(now)).toBe(0);
  });
});

describe('tag updates', () => {
  it('merges one image at a time without disturbing the others', async () => {
    await writeFlipRecord(record());
    await updateFlipTags('batch-1', { 'SD/IMG_0001.JPG': [coyote] });
    await updateFlipTags('batch-1', { 'SD/IMG_0002.JPG': [ghost] });
    const back = await readFlipRecord('batch-1');
    expect(back!.tags).toEqual({ 'SD/IMG_0001.JPG': [coyote], 'SD/IMG_0002.JPG': [ghost] });
  });

  it('ignores an id that is not there rather than creating one', async () => {
    await updateFlipTags('gone', { x: [coyote] });
    expect(await readFlipRecord('gone')).toBeUndefined();
  });
});

describe('the hand back', () => {
  it('merges the final tags and records who tagged them', async () => {
    await writeFlipRecord(record({ tags: { 'SD/IMG_0001.JPG': [coyote] } }));
    await finishFlipRecord('batch-1', { 'SD/IMG_0002.JPG': [ghost] }, 'anita');
    const back = await readFlipRecord('batch-1');
    expect(back!.tags).toEqual({ 'SD/IMG_0001.JPG': [coyote], 'SD/IMG_0002.JPG': [ghost] });
    expect(back!.taggerUser).toBe('anita');
  });

  it('accepts a blank tagger identity — the tagger never forces one', async () => {
    await writeFlipRecord(record());
    await finishFlipRecord('batch-1', {}, '');
    expect((await readFlipRecord('batch-1'))!.taggerUser).toBe('');
  });
});

it('reads old records and resolves optional estimated timestamps after camera and manual time', async () => {
  await writeFlipRecord(record());
  expect(await readFlipRecord('batch-1')).toEqual(record());
  const f = inspected({ exifTimestamp: undefined, estimatedTimestamp: '2024-01-10T08:00:00', timestampSource: 'interpolated' });
  await writeFlipRecord(record({ files: [f] }));
  expect((await readFlipRecord('batch-1'))?.files[0]).toEqual(f);
  expect(captureTimestampOf(f)).toBe(f.estimatedTimestamp);
  expect(captureTimestampOf({ ...f, manualTimestamp: 'manual' })).toBe('manual');
  expect(captureTimestampOf({ ...f, manualTimestamp: 'manual', exifTimestamp: 'camera' })).toBe('camera');
});
