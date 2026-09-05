// Per-file inspect-step verdicts and the batch-ready gate.

import { describe, it, expect } from 'vitest';
import { validateBatch, summarize, processingComplete } from '../src/lib/validation';
import type { FileEntry } from '../src/store';
import type { NaiveDateTime } from '../src/lib/exifTime';

const NAIVE: NaiveDateTime = { year: 2024, month: 1, day: 10, hour: 8, minute: 0, second: 0 };

function file(over: Partial<FileEntry>): FileEntry {
  // Default the hash off the id so unrelated files don't accidentally collide
  // into the duplicate-content warning; tests that exercise dups set it explicitly.
  return {
    id: over.relPath ?? over.id ?? 'IMG.JPG',
    file: new File([new Uint8Array(1)], 'IMG.JPG', { type: 'image/jpeg' }),
    relPath: 'IMG.JPG',
    fileName: 'IMG.JPG',
    size: 1024,
    mediaKind: 'image',
    processState: 'ready',
    sha256: `sha-${over.id ?? over.relPath ?? 'IMG'}`,
    exifNaive: NAIVE,
    ...over,
  };
}

describe('validateBatch severities', () => {
  it('clean ready file is ok', () => {
    const v = validateBatch([file({ id: 'a', relPath: 'a/IMG.JPG' })]);
    expect(v['a'].severity).toBe('ok');
    expect(v['a'].issues).toEqual([]);
  });

  it('errors on processing failure', () => {
    const v = validateBatch([
      file({ id: 'a', relPath: 'a', processState: 'error', processError: 'decode failed' }),
    ]);
    expect(v['a'].severity).toBe('error');
    expect(v['a'].issues[0].message).toBe('decode failed');
  });

  it('errors on an unsafe relative path', () => {
    const v = validateBatch([file({ id: 'a', relPath: '../escape.jpg' })]);
    expect(v['a'].severity).toBe('error');
    expect(v['a'].issues.some((i) => i.message.includes('Unsafe filename'))).toBe(true);
  });

  it('warns (not blocks) when a ready file has no capture time', () => {
    const v = validateBatch([file({ id: 'a', relPath: 'a', exifNaive: undefined })]);
    expect(v['a'].severity).toBe('warning');
    expect(v['a'].issues[0].message).toBe('No camera time — estimated from neighbouring files, marked as a known timestamp issue');
  });

  it('warns when a ready video has no container timestamp (manual-entry path)', () => {
    const v = validateBatch([
      file({
        id: 'a',
        relPath: 'a/CLIP.MP4',
        mediaKind: 'video',
        mimeType: 'video/mp4',
        exifNaive: undefined,
      }),
    ]);
    expect(v['a'].severity).toBe('warning');
    expect(v['a'].issues[0].message).toBe('No camera time — estimated from neighbouring files, marked as a known timestamp issue');
  });

  it('a manual capture time remains a known timestamp issue', () => {
    const v = validateBatch([file({ id: 'a', relPath: 'a', exifNaive: undefined, manualNaive: NAIVE })]);
    expect(v['a'].severity).toBe('warning');
    expect(v['a'].issues[0].message).toBe('No camera time — set by hand, marked as a known timestamp issue');
  });

  it('a ready video with a container timestamp is ok', () => {
    const v = validateBatch([
      file({ id: 'a', relPath: 'a/CLIP.MP4', mediaKind: 'video', mimeType: 'video/mp4' }),
    ]);
    expect(v['a'].severity).toBe('ok');
    expect(v['a'].issues).toEqual([]);
  });

  it('warns (not blocks) on an oversized file', () => {
    const v = validateBatch([file({ id: 'a', relPath: 'a', size: 200 * 1024 * 1024 })]);
    expect(v['a'].severity).toBe('warning');
  });

  it('warns on duplicate content hashes, flagging every copy', () => {
    const v = validateBatch([
      file({ id: 'a', relPath: 'a', sha256: 'dup' }),
      file({ id: 'b', relPath: 'b', sha256: 'dup' }),
    ]);
    expect(v['a'].severity).toBe('warning');
    expect(v['b'].severity).toBe('warning');
    expect(v['a'].issues.some((i) => i.message.includes('Duplicate'))).toBe(true);
  });
});

describe('summarize / ready gate', () => {
  it('stays ready while files are still processing (Inspect no longer blocks on pending)', () => {
    const files = [
      file({ id: 'a', relPath: 'a' }),
      file({ id: 'b', relPath: 'b', processState: 'processing' }),
    ];
    const s = summarize(files, validateBatch(files));
    expect(s.pending).toBe(1);
    expect(s.ready).toBe(true);
  });

  it('is not ready while a blocking error stands', () => {
    const files = [file({ id: 'a', relPath: '../x.jpg' })];
    const s = summarize(files, validateBatch(files));
    expect(s.errors).toBe(1);
    expect(s.ready).toBe(false);
  });

  it('is ready when processed, error-free, and non-empty (warnings allowed)', () => {
    const files = [
      file({ id: 'a', relPath: 'a' }),
      file({ id: 'b', relPath: 'b', size: 200 * 1024 * 1024 }), // warning only
    ];
    const s = summarize(files, validateBatch(files));
    expect(s.warnings).toBe(1);
    expect(s.errors).toBe(0);
    expect(s.ready).toBe(true);
  });

  it('stays ready when a file is missing a capture time (now only a warning)', () => {
    const files = [file({ id: 'a', relPath: 'a', exifNaive: undefined })];
    const s = summarize(files, validateBatch(files));
    expect(s.warnings).toBe(1);
    expect(s.errors).toBe(0);
    expect(s.ready).toBe(true);
    expect(s.noCameraTime).toBe(1);
  });

  it('an empty batch is never ready', () => {
    expect(summarize([], {}).ready).toBe(false);
  });
});

describe('processingComplete', () => {
  it('is false while any file is still queued or processing', () => {
    expect(processingComplete([file({ id: 'a', relPath: 'a', processState: 'queued' })])).toBe(false);
    expect(processingComplete([file({ id: 'a', relPath: 'a', processState: 'processing' })])).toBe(false);
  });

  it('is true once every file is ready or errored — an error still counts as finished', () => {
    const files = [
      file({ id: 'a', relPath: 'a', processState: 'ready' }),
      file({ id: 'b', relPath: 'b', processState: 'error', processError: 'boom' }),
    ];
    expect(processingComplete(files)).toBe(true);
  });

  it('is false for an empty batch', () => {
    expect(processingComplete([])).toBe(false);
  });
});
