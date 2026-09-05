import { it, expect } from 'vitest';
import { buildMediaComments, timestampSourceFromComments, serializeMedia, parseMedia, mergeMedia, parseCsvRows, type TimestampSource } from '../src/index';

it.each<TimestampSource>(['manual', 'spread', 'interpolated', 'offset', 'file-modified'])('round trips %s', (timestampSource) => {
  expect(timestampSourceFromComments(buildMediaComments({ timestampSource }))).toBe(timestampSource);
});
it('returns no source for absent or unknown markers', () => {
  expect(buildMediaComments({})).toBe('');
  expect(timestampSourceFromComments('')).toBeNull();
  expect(timestampSourceFromComments('[TIMESTAMP:unknown]')).toBeNull();
});
it('preserves media comments through merge, parse, append and re-serialization', () => {
  const comments = '[TIMESTAMP:interpolated] note, "keep this"';
  const csv = serializeMedia([{ mediaId: 'a', mediaPath: 'a', deploymentId: 'd', fileName: 'a', timestamp: 'old', mimeType: 'image/jpeg', comments }]);
  const merged = mergeMedia(csv, [{ mediaId: 'a', deploymentId: 'd', timestamp: 'new', mediaTimestamp: 'new', observations: [] }]);
  const rows = parseMedia(merged);
  const appended = serializeMedia([...rows, { ...rows[0], mediaId: 'b', mediaPath: 'b' }]);
  expect(parseCsvRows(appended)[0][10]).toBe(comments);
  expect(merged.replace('"new"', '"old"')).toBe(csv);
  expect(serializeMedia(rows)).toBe(merged);
});
