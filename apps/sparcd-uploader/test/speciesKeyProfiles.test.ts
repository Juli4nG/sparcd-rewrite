import { describe, expect, it } from 'vitest';
import {
  acknowledgeSpeciesProfile,
  pendingSpeciesProfile,
  shouldReconcileSpeciesProfile,
  speciesKeyProfileId,
  stageSpeciesProfile,
} from '../src/lib/speciesKeyProfiles';
import {
  KEYBINDING_STORAGE_KEY,
  mergeAndWriteRevisionedProfiles,
  readRevisionedProfiles,
  type Revision,
  type RevisionedKeyProfiles,
} from '@sparcd/auth-ui';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const before = [
  { scientificName: 'a', commonName: 'Alpha', keyBinding: 'A' },
  { scientificName: 'removed', commonName: 'Removed', keyBinding: 'R' },
];
const after = [
  { scientificName: 'a', commonName: 'Alpha updated', keyBinding: '?' },
  { scientificName: 'added', commonName: 'Added', keyBinding: 'N' },
];

describe('uploader species-keybinding preflight', () => {
  it('checks only after login, not when restoring a session on refresh', () => {
    expect(shouldReconcileSpeciesProfile(0)).toBe(false);
    expect(shouldReconcileSpeciesProfile(1)).toBe(true);
  });
  it('uses the same endpoint/user profile identity as the tagger', () => {
    expect(speciesKeyProfileId(' https://s3.example ', ' alice ')).toBe(
      'https://s3.example\u0000alice',
    );
  });

  it('removes the one-time legacy profile after a scoped profile claims it', () => {
    const storage = memoryStorage();
    storage.setItem(
      KEYBINDING_STORAGE_KEY,
      JSON.stringify({ state: { overrides: { a: '!' } }, version: 1 }),
    );

    stageSpeciesProfile(storage, speciesKeyProfileId('server', 'alice'), before);

    const profiles = readRevisionedProfiles(storage);
    expect(profiles.__legacy__).toBeUndefined();
    expect(profiles[speciesKeyProfileId('server', 'alice')].overrides.a).toBe('!');
  });

  it('keeps changes pending until acknowledgement and then prunes removed overrides', () => {
    const storage = memoryStorage();
    const profileId = speciesKeyProfileId('server', 'alice');
    expect(stageSpeciesProfile(storage, profileId, before)).toBeNull();

    const stored = JSON.parse(storage.getItem('sparcd-tagger-keybindings')!) as {
      state: { profiles: Record<string, { overrides: Record<string, string | null> }> };
    };
    stored.state.profiles[profileId].overrides.removed = '!';
    storage.setItem('sparcd-tagger-keybindings', JSON.stringify(stored));

    const diff = stageSpeciesProfile(storage, profileId, after)!;
    expect(diff.added[0].scientificName).toBe('added');
    expect(diff.removed[0].scientificName).toBe('removed');
    expect(diff.modified[0].after.commonName).toBe('Alpha updated');
    expect(pendingSpeciesProfile(storage, profileId)).toEqual(diff);

    acknowledgeSpeciesProfile(storage, profileId);
    const acknowledged = JSON.parse(storage.getItem('sparcd-tagger-keybindings')!) as {
      state: {
        profiles: Record<
          string,
          { overrides: Record<string, string | null>; pendingSpeciesChange?: unknown }
        >;
      };
    };
    expect(acknowledged.state.profiles[profileId].overrides.removed).toBeNull();
    expect(acknowledged.state.profiles[profileId].pendingSpeciesChange).toBeUndefined();
  });

  it('merges different species written from concurrent stale profile snapshots', () => {
    const storage = memoryStorage();
    const profileId = speciesKeyProfileId('server', 'alice');
    const revision = (at: number, writer: string): Revision => ({ at, sequence: 1, writer });
    const staleWriter = (
      scientificName: string,
      key: string | null,
      at: number,
      writer: string,
    ): RevisionedKeyProfiles => ({
      [profileId]: {
        overrides: { [scientificName]: key },
        overrideRevisions: { [scientificName]: revision(at, writer) },
      },
    });

    mergeAndWriteRevisionedProfiles(storage, staleWriter('a', 'a', 1, 'tab-a'));
    mergeAndWriteRevisionedProfiles(storage, staleWriter('b', 'b', 1, 'tab-b'));

    expect(readRevisionedProfiles(storage)[profileId].overrides).toEqual({ a: 'a', b: 'b' });
  });

  it('keeps a newer removal tombstone when a stale writer restores an old assignment', () => {
    const storage = memoryStorage();
    const profileId = speciesKeyProfileId('server', 'alice');
    const profiles = (key: string | null, at: number, writer: string): RevisionedKeyProfiles => ({
      [profileId]: {
        overrides: { removed: key },
        overrideRevisions: { removed: { at, sequence: 1, writer } },
      },
    });

    mergeAndWriteRevisionedProfiles(storage, profiles(null, 2, 'uploader'));
    mergeAndWriteRevisionedProfiles(storage, profiles('!', 1, 'stale-tagger'));

    expect(readRevisionedProfiles(storage)[profileId].overrides.removed).toBeNull();
    expect(storage.getItem(KEYBINDING_STORAGE_KEY)).toContain('"version":3');
  });
});
