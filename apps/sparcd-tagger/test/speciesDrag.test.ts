import { describe, expect, it } from 'vitest';
import { encodeSpeciesDrag, parseSpeciesDrag } from '../src/lib/speciesDrag';

describe('species drag payload', () => {
  it('round-trips a valid species as an increment-at-one tag', () => {
    expect(parseSpeciesDrag(encodeSpeciesDrag({
      scientificName: ' Canis latrans ',
      commonName: 'Coyote',
    }))).toEqual({ scientificName: 'Canis latrans', commonName: 'Coyote', count: 1 });
  });

  it.each([
    '',
    'not json',
    'null',
    '{}',
    '{"scientificName":"","commonName":"Ghost"}',
    '{"scientificName":"Casper","commonName":7}',
  ])('rejects malformed or incomplete data: %s', (raw) => {
    expect(parseSpeciesDrag(raw)).toBeNull();
  });
});
