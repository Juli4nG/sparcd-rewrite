import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type KeyStore = typeof import('../src/lib/keys').useKeyBindings;

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  },
});

let useKeyBindings: KeyStore;
let rehydrateKeyBindings: typeof import('../src/lib/keys').rehydrateKeyBindings;

beforeAll(async () => {
  ({ useKeyBindings, rehydrateKeyBindings } = await import('../src/lib/keys'));
});

const original = [
  { scientificName: 'a', commonName: 'Alpha', keyBinding: 'A' },
  { scientificName: 'removed', commonName: 'Removed', keyBinding: 'R' },
];
const changed = [
  { scientificName: 'a', commonName: 'Alpha renamed', keyBinding: '?' },
  { scientificName: 'added', commonName: 'Added', keyBinding: 'N' },
];

describe('per-user keybinding profiles', () => {
  beforeEach(() => {
    values.clear();
    useKeyBindings.setState({ profiles: {}, activeProfileId: null });
  });

  it('isolates assignments for two endpoint/user profiles', () => {
    const store = useKeyBindings.getState();
    store.activateProfile('server\u0000alice');
    useKeyBindings.getState().assignKey('a', '?');
    useKeyBindings.getState().activateProfile('server\u0000bob');
    expect(useKeyBindings.getState().profiles['server\u0000bob'].overrides).toEqual({});
    useKeyBindings.getState().assignKey('a', '#');
    expect(useKeyBindings.getState().profiles['server\u0000alice'].overrides.a).toBe('?');
  });

  it('persists null tombstones and atomic duplicate transfers', () => {
    useKeyBindings.getState().activateProfile('server\u0000alice');
    useKeyBindings.getState().assignKey('a', 'd');
    useKeyBindings.getState().assignKey('b', 'd', ['a']);
    expect(useKeyBindings.getState().profiles['server\u0000alice'].overrides).toEqual({
      a: null,
      b: 'd',
    });
    expect(localStorage.getItem('sparcd-tagger-keybindings')).toContain('"a":null');
  });

  it('keeps vocabulary changes pending until explicit acknowledgement', () => {
    useKeyBindings.getState().activateProfile('server\u0000alice');
    useKeyBindings.getState().stageSpecies(original);
    useKeyBindings.getState().assignKey('removed', '!');
    useKeyBindings.getState().stageSpecies(changed);
    let profile = useKeyBindings.getState().profiles['server\u0000alice'];
    expect(profile.pendingSpeciesChange?.diff.added[0].scientificName).toBe('added');
    expect(profile.acceptedSpecies).toEqual(original);
    expect(profile.overrides.removed).toBe('!');

    useKeyBindings.getState().acknowledgeSpeciesChange();
    profile = useKeyBindings.getState().profiles['server\u0000alice'];
    expect(profile.pendingSpeciesChange).toBeUndefined();
    expect(profile.acceptedSpecies).toEqual(changed);
    expect(profile.overrides.removed).toBeNull();
  });

  it('distinguishes an accepted empty vocabulary from an uninitialized profile', () => {
    useKeyBindings.getState().activateProfile('server\u0000alice');
    useKeyBindings.getState().stageSpecies([]);
    useKeyBindings.getState().stageSpecies(changed);
    expect(
      useKeyBindings.getState().profiles['server\u0000alice'].pendingSpeciesChange?.diff.added,
    ).toHaveLength(2);
  });

  it('rehydrates another tab\'s update without changing this tab\'s active profile', async () => {
    useKeyBindings.getState().activateProfile('server\u0000alice');
    useKeyBindings.getState().assignKey('a', '?');
    const stored = JSON.parse(localStorage.getItem('sparcd-tagger-keybindings')!) as {
      state: { profiles: Record<string, { overrides: Record<string, string | null> }> };
      version: number;
    };
    stored.state.profiles['server\u0000alice'].overrides.b = '#';
    localStorage.setItem('sparcd-tagger-keybindings', JSON.stringify(stored));

    rehydrateKeyBindings();

    expect(useKeyBindings.getState().activeProfileId).toBe('server\u0000alice');
    expect(useKeyBindings.getState().profiles['server\u0000alice'].overrides).toMatchObject({
      a: '?',
      b: '#',
    });
    expect(JSON.parse(localStorage.getItem('sparcd-tagger-keybindings')!).state.profiles[
      'server\u0000alice'
    ].overrides).toMatchObject({ a: '?', b: '#' });
  });

  it('merges a concurrent stale-tab assignment during full store rehydration', () => {
    const profileId = 'server\u0000alice';
    useKeyBindings.getState().activateProfile(profileId);
    const staleTab = JSON.parse(localStorage.getItem('sparcd-tagger-keybindings')!) as {
      state: {
        profiles: Record<
          string,
          {
            overrides: Record<string, string | null>;
            overrideRevisions: Record<string, { at: number; sequence: number; writer: string }>;
          }
        >;
      };
      version: number;
    };

    useKeyBindings.getState().assignKey('a', 'a');
    staleTab.state.profiles[profileId].overrides.b = 'b';
    staleTab.state.profiles[profileId].overrideRevisions.b = {
      at: Date.now() + 1,
      sequence: 1,
      writer: 'stale-tab',
    };
    localStorage.setItem('sparcd-tagger-keybindings', JSON.stringify(staleTab));

    rehydrateKeyBindings();

    expect(useKeyBindings.getState().profiles[profileId].overrides).toMatchObject({ a: 'a', b: 'b' });
    const persisted = JSON.parse(localStorage.getItem('sparcd-tagger-keybindings')!) as {
      state: { profiles: Record<string, { overrides: Record<string, string | null> }> };
    };
    expect(persisted.state.profiles[profileId].overrides).toMatchObject({ a: 'a', b: 'b' });
  });
});
