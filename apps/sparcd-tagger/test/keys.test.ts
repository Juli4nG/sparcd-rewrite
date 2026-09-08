// Java KeyCode → `KeyboardEvent.key` normalization, and override-wins
// resolution. Data-compatible with the desktop app's persisted `keyBinding`.

import { describe, it, expect } from 'vitest';
import { shouldReconcileSpeciesProfile } from '@sparcd/auth-ui';
import {
  conflictingKeyOwners,
  diffSpecies,
  effectiveKey,
  normalizeBindableEventKey,
  normalizeEventKey,
  normalizeJavaKeyCode,
} from '../src/lib/keys';

describe('normalizeJavaKeyCode', () => {
  it('maps single letters to a lowercase key char', () => {
    expect(normalizeJavaKeyCode('D')).toBe('d');
  });

  it('maps DIGIT/NUMPAD codes to the digit char', () => {
    expect(normalizeJavaKeyCode('DIGIT1')).toBe('1');
    expect(normalizeJavaKeyCode('NUMPAD7')).toBe('7');
  });

  it('maps raw and Java-named symbol keys', () => {
    expect(normalizeJavaKeyCode('?')).toBe('?');
    expect(normalizeJavaKeyCode('SLASH')).toBe('/');
    expect(normalizeJavaKeyCode('SEMICOLON')).toBe(';');
    expect(normalizeJavaKeyCode('OPEN_BRACKET')).toBe('[');
    expect(normalizeJavaKeyCode('BACK_SLASH')).toBe('\\');
  });

  it('returns null for empty / unbindable codes', () => {
    expect(normalizeJavaKeyCode(null)).toBeNull();
    expect(normalizeJavaKeyCode('')).toBeNull();
    expect(normalizeJavaKeyCode('ENTER')).toBeNull();
  });
});

describe('login-only species reconciliation', () => {
  it('skips restored sessions and runs after an explicit or relayed login', () => {
    expect(shouldReconcileSpeciesProfile(0)).toBe(false);
    expect(shouldReconcileSpeciesProfile(1)).toBe(true);
  });

  it('still initializes local-batch profiles without an S3 login', () => {
    expect(shouldReconcileSpeciesProfile(0, true)).toBe(true);
  });
});

describe('normalizeEventKey', () => {
  it('accepts alphanumeric, shifted punctuation, and Unicode symbols', () => {
    expect(normalizeEventKey('A')).toBe('a');
    expect(normalizeEventKey('7')).toBe('7');
    expect(normalizeEventKey('?')).toBe('?');
    expect(normalizeEventKey('§')).toBe('§');
  });

  it('accepts every printable ASCII alphanumeric and symbol key except whitespace', () => {
    const printable = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33));
    for (const key of printable) expect(normalizeEventKey(key)).not.toBeNull();
  });

  it('rejects whitespace and named control keys', () => {
    expect(normalizeEventKey(' ')).toBeNull();
    expect(normalizeEventKey('Enter')).toBeNull();
  });
});

describe('normalizeBindableEventKey', () => {
  const event = (key: string, modifiers = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it('rejects Alt/Option, Control, and Meta modified printable keys', () => {
    expect(normalizeBindableEventKey(event('j', { altKey: true }))).toBeNull();
    expect(normalizeBindableEventKey(event('j', { ctrlKey: true }))).toBeNull();
    expect(normalizeBindableEventKey(event('j', { metaKey: true }))).toBeNull();
  });

  it('preserves Shift-produced symbols and normalizes alphabetic case', () => {
    expect(normalizeBindableEventKey(event('!', { shiftKey: true }))).toBe('!');
    expect(normalizeBindableEventKey(event('A', { shiftKey: true }))).toBe('a');
    expect(normalizeBindableEventKey(event('a'))).toBe('a');
  });
});

describe('effectiveKey', () => {
  it('prefers a local override over the species.json binding', () => {
    expect(effectiveKey('Canis latrans', 'D', { 'Canis latrans': 'c' })).toBe('c');
  });

  it('falls back to the normalized species.json binding', () => {
    expect(effectiveKey('Canis latrans', 'D', {})).toBe('d');
  });

  it('is null when neither source binds the species', () => {
    expect(effectiveKey('Canis latrans', null, {})).toBeNull();
  });

  it('honors both null and legacy empty-string tombstones', () => {
    expect(effectiveKey('Canis latrans', 'C', { 'Canis latrans': null })).toBeNull();
    expect(effectiveKey('Canis latrans', 'C', { 'Canis latrans': '' })).toBeNull();
  });
});

describe('species configuration reconciliation', () => {
  it('detects additions, removals, and modified defaults', () => {
    const before = [
      { scientificName: 'a', commonName: 'Alpha', keyBinding: 'A' },
      { scientificName: 'b', commonName: 'Beta', keyBinding: 'B' },
    ];
    const after = [
      { scientificName: 'a', commonName: 'Alpha renamed', keyBinding: '?' },
      { scientificName: 'c', commonName: 'Gamma', keyBinding: 'C' },
    ];
    const diff = diffSpecies(before, after);
    expect(diff.added.map((entry) => entry.scientificName)).toEqual(['c']);
    expect(diff.removed.map((entry) => entry.scientificName)).toEqual(['b']);
    expect(diff.modified.map((entry) => entry.after.scientificName)).toEqual(['a']);
  });

  it('finds duplicate owners across defaults and overrides but ignores tombstones', () => {
    const species = [
      { scientificName: 'a', commonName: 'Alpha', keyBinding: 'D' },
      { scientificName: 'b', commonName: 'Beta', keyBinding: null },
      { scientificName: 'c', commonName: 'Gamma', keyBinding: 'D' },
      { scientificName: 'target', commonName: 'Target', keyBinding: null },
    ];
    expect(conflictingKeyOwners(species, 'target', 'd', { b: 'd', c: null })).toEqual([
      'a',
      'b',
    ]);
  });
});
