// Per-file validation for the inspect step. Pure: takes processed files and
// returns one verdict per file id. Severity drives the gate — `error` blocks the
// batch, `warning` is allowed once surfaced, `ok` is clean. Duplicate detection
// is cross-file (SHA-256), so the batch pass supplies duplicate counts.

import type { FileEntry } from '../store';
import { sanitizeRelPath } from './normalize';

export type Severity = 'ok' | 'warning' | 'error';

export type FileValidation = {
  severity: Severity;
  issues: { severity: Exclude<Severity, 'ok'>; message: string }[];
};

// Soft warning ceiling — unusual for a camera-trap JPEG, but allowed.
const SOFT_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MiB

export function validateFile(f: FileEntry, dupCount = 0): FileValidation {
  const issues: FileValidation['issues'] = [];

  if (f.processState === 'error') {
    issues.push({ severity: 'error', message: f.processError ?? 'Processing failed' });
  }

  // Object-key safety. The scan guarantees an accepted media type, so the only
  // name failure mode here is an unsafe relative path.
  const nameResult = sanitizeRelPath(f.relPath);
  if (!nameResult.ok) {
    issues.push({ severity: 'error', message: `Unsafe filename — ${nameResult.reason}` });
  }

  if (f.processState === 'ready' && !f.exifNaive) {
    issues.push({ severity: 'warning', message: f.manualNaive
      ? 'No camera time — set by hand, marked as a known timestamp issue'
      : 'No camera time — estimated from neighbouring files, marked as a known timestamp issue' });
  }

  if (f.size > SOFT_SIZE_LIMIT) {
    issues.push({ severity: 'warning', message: 'Large file (>100 MiB) — unusual for camera-trap' });
  }

  if (f.sha256 && dupCount > 1) {
    issues.push({ severity: 'warning', message: 'Duplicate of another file in this batch' });
  }

  const severity: Severity = issues.some((i) => i.severity === 'error')
    ? 'error'
    : issues.some((i) => i.severity === 'warning')
      ? 'warning'
      : 'ok';
  return { severity, issues };
}

export function validateBatch(files: FileEntry[]): Record<string, FileValidation> {
  // Count content hashes so a hash seen more than once flags every copy.
  const hashCounts = new Map<string, number>();
  for (const f of files) {
    if (f.sha256) hashCounts.set(f.sha256, (hashCounts.get(f.sha256) ?? 0) + 1);
  }

  const out: Record<string, FileValidation> = {};
  for (const f of files) {
    out[f.id] = validateFile(f, hashCounts.get(f.sha256 ?? '') ?? 0);
  }
  return out;
}

// The hard processing-complete gate: every file must have finished processing
// (ready or error) before an upload can start, so a file still queued/processing
// is never silently left out of the batch. Consumed at the Assign Continue gate
// — NOT in the inspect summary, so inspect doesn't force a wait for a large
// batch to finish before the user can start Assign work (picking a deployment,
// naming the upload) that doesn't depend on per-file processing results.
export function processingComplete(files: FileEntry[]): boolean {
  return (
    files.length > 0 && files.every((f) => f.processState === 'ready' || f.processState === 'error')
  );
}

export type BatchSummary = {
  total: number;
  noCameraTime: number;
  processed: number;
  pending: number; // queued + processing
  errors: number;
  warnings: number;
  ready: boolean; // no blocking errors — processing may still be running in the background
};

export function summarize(
  files: FileEntry[],
  validations: Record<string, FileValidation>,
): BatchSummary {
  let processed = 0;
  let pending = 0;
  let errors = 0;
  let warnings = 0;
  for (const f of files) {
    if (f.processState === 'ready' || f.processState === 'error') processed++;
    else pending++;
    const v = validations[f.id];
    if (v?.severity === 'error') errors++;
    else if (v?.severity === 'warning') warnings++;
  }
  return {
    total: files.length,
    noCameraTime: files.filter((f) => f.processState === 'ready' && !f.exifNaive).length,
    processed,
    pending,
    errors,
    warnings,
    ready: files.length > 0 && errors === 0,
  };
}
