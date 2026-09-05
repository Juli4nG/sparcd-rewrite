// Per-upload timezone handling for EXIF capture time.
//
// EXIF DateTimeOriginal/CreateDate/ModifyDate are NAIVE wall-clock strings with
// no zone. The camera wrote them in *its* local time; the uploading machine's
// zone is irrelevant. We capture the components verbatim (never letting
// `new Date(localString)` reinterpret them in the browser's zone), then
// interpret them in a user-chosen IANA zone to get the true UTC instant. The
// result is emitted as a full ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`)
// — matching how sparcd-web itself stamps observation timestamps
// (`datetime.now(UTC).isoformat()` in `camtrap_utils.py`) — the shape media.csv
// col 4 and observations.csv col 4 now carry.

/** Naive EXIF wall-clock with no zone — the components as written by the camera. */
export type NaiveDateTime = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
};

/** The browser's resolved IANA zone; the default tz for a new upload. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** All IANA zones for the picker. */
export function supportedTimeZones(): string[] {
  return Intl.supportedValuesOf('timeZone');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Format naive components as canonical `YYYY-MM-DDTHH:mm:ss` (no Z). */
export function formatNaive(n: NaiveDateTime): string {
  return (
    `${String(n.year).padStart(4, '0')}-${pad(n.month)}-${pad(n.day)}T` +
    `${pad(n.hour)}:${pad(n.minute)}:${pad(n.second)}`
  );
}

/** Naive components as a `<input type="datetime-local" step="1">` value. The
 *  canonical `YYYY-MM-DDTHH:mm:ss` form is exactly what such an input accepts. */
export function naiveToInputValue(n: NaiveDateTime): string {
  return formatNaive(n);
}

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Parse a `datetime-local` value into raw naive components — NO timezone math
 *  (the chosen upload zone is applied later at bundle build, same as EXIF). Some
 *  browsers omit seconds at step=1, so seconds default to 0. Returns null on an
 *  empty or malformed value so the caller clears the override. */
export function inputValueToNaive(v: string): NaiveDateTime | null {
  const m = INPUT_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const n: NaiveDateTime = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s ? Number(s) : 0,
  };
  if (n.hour > 23 || n.minute > 59 || n.second > 59) return null;
  // Reject calendar-impossible dates (Feb 31, Apr 31, Feb 29 in a non-leap year,
  // day 0). A bare 1..31 day bound would let those through, and the later naive→
  // UTC conversion would silently normalize them into a DIFFERENT real date and
  // publish it as the authoritative capture time. Round-trip via a UTC Date (no
  // zone, so no DST shift contaminates the day check) and require an exact match.
  const probe = new Date(Date.UTC(n.year, n.month - 1, n.day));
  if (
    probe.getUTCFullYear() !== n.year ||
    probe.getUTCMonth() !== n.month - 1 ||
    probe.getUTCDate() !== n.day
  ) {
    return null;
  }
  return n;
}

// Read the wall-clock components a given UTC instant has *in* `timeZone`. Built
// once per zone; en-US + hourCycle h23 keeps midnight at 00 (not 24).
// Constructing an Intl.DateTimeFormat costs ~35µs; a 5k-file bundle rebuild
// calls this 10k+ times, so the per-zone cache is load-bearing for UI latency.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, fmt);
  }
  return fmt;
}

export function partsInZone(utcMs: number, timeZone: string): NaiveDateTime {
  const fmt = formatterFor(timeZone);
  const map: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

// Difference, in milliseconds, between the wall-clock `partsInZone` produced for
// `utcMs` and the wall-clock we *wanted* (`target`). Subtracting it from the
// UTC guess steers toward the offset that makes the zone show `target`.
function deltaMs(produced: NaiveDateTime, target: NaiveDateTime): number {
  return Date.UTC(produced.year, produced.month - 1, produced.day, produced.hour, produced.minute, produced.second) -
    Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
}

/**
 * Interpret naive wall-clock components AS IF in `timeZone`, returning the true
 * UTC instant as a full ISO 8601 string (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 *
 * DST-correct without a heavy dependency: start from a UTC guess equal to the
 * components, ask Intl what wall-clock that guess shows in `timeZone`, and
 * subtract the gap to home in on the offset. One pass handles the common case;
 * a second pass resolves the DST fold/gap where the offset itself changes
 * within the corrected window. Spring-forward gaps (a wall-clock that doesn't
 * exist) and fall-back folds (ambiguous) resolve deterministically to whatever
 * the two-pass fixed point lands on — pinned by tests, never throws.
 */
export function naiveInZoneToUtcIso(n: NaiveDateTime, timeZone: string): string {
  let guess = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
  guess -= deltaMs(partsInZone(guess, timeZone), n);
  // Second pass: if the first correction crossed a DST boundary, the offset at
  // the corrected instant may differ; re-correct from there.
  guess -= deltaMs(partsInZone(guess, timeZone), n);

  return new Date(guess).toISOString();
}
