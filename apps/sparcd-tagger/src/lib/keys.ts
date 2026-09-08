import { create } from 'zustand';
import {
  KEYBINDING_STORAGE_KEY,
  emptyRevisionedProfile,
  keyProfileId,
  mergeAndWriteRevisionedProfiles,
  mergeRevisionedProfiles,
  nextKeyProfileRevision,
  readRevisionedProfiles,
  type RevisionedKeyProfile,
  type RevisionedKeyProfiles,
  type SpeciesDiff,
  type SpeciesKeyConfig,
} from '@sparcd/auth-ui';

export type KeyOverrides = Record<string, string | null>;
export type KeyProfile = RevisionedKeyProfile;
export type { SpeciesDiff, SpeciesKeyConfig };
export { keyProfileId };

type KeyBindingState = {
  profiles: RevisionedKeyProfiles;
  activeProfileId: string | null;
  activateProfile: (profileId: string) => void;
  assignKey: (
    scientificName: string,
    key: string,
    displacedScientificNames?: string[],
  ) => void;
  clearKey: (scientificName: string) => void;
  stageSpecies: (current: SpeciesKeyConfig[]) => void;
  acknowledgeSpeciesChange: () => void;
};

const LEGACY_PROFILE = '__legacy__';

export function normalizeJavaKeyCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  if ([...trimmed].length === 1) return trimmed.toLocaleLowerCase();
  const upper = trimmed.toUpperCase();
  const digit = /^(?:DIGIT|NUMPAD)([0-9])$/.exec(upper);
  if (digit) return digit[1];
  const symbols: Record<string, string> = {
    BACK_QUOTE: '`',
    COMMA: ',',
    PERIOD: '.',
    SLASH: '/',
    SEMICOLON: ';',
    QUOTE: "'",
    OPEN_BRACKET: '[',
    CLOSE_BRACKET: ']',
    BACK_SLASH: '\\',
    MINUS: '-',
    EQUALS: '=',
  };
  return symbols[upper] ?? null;
}

export function normalizeEventKey(key: string): string | null {
  return [...key].length === 1 && !/^\s$/u.test(key) ? key.toLocaleLowerCase() : null;
}

export function normalizeBindableEventKey(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): string | null {
  return event.altKey || event.ctrlKey || event.metaKey ? null : normalizeEventKey(event.key);
}

export function effectiveKey(
  scientificName: string,
  jsonKeyBinding: string | null,
  overrides: KeyOverrides | Record<string, string>,
): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, scientificName)) {
    const override = overrides[scientificName];
    return override === '' ? null : override;
  }
  return normalizeJavaKeyCode(jsonKeyBinding);
}

export function conflictingKeyOwners(
  species: readonly SpeciesKeyConfig[],
  targetScientificName: string,
  key: string,
  overrides: KeyOverrides,
): string[] {
  return species
    .filter(
      (candidate) =>
        candidate.scientificName !== targetScientificName &&
        effectiveKey(candidate.scientificName, candidate.keyBinding, overrides) === key,
    )
    .map((candidate) => candidate.scientificName);
}

export function diffSpecies(
  accepted: readonly SpeciesKeyConfig[],
  current: readonly SpeciesKeyConfig[],
): SpeciesDiff {
  const before = new Map(accepted.map((species) => [species.scientificName, species]));
  const after = new Map(current.map((species) => [species.scientificName, species]));
  return {
    added: current.filter((species) => !before.has(species.scientificName)),
    removed: accepted.filter((species) => !after.has(species.scientificName)),
    modified: current.flatMap((species) => {
      const prior = before.get(species.scientificName);
      return prior &&
        (prior.commonName !== species.commonName || prior.keyBinding !== species.keyBinding)
        ? [{ before: prior, after: species }]
        : [];
    }),
  };
}

function normalizedSpecies(species: readonly SpeciesKeyConfig[]): SpeciesKeyConfig[] {
  return species
    .map(({ scientificName, commonName, keyBinding }) => ({
      scientificName,
      commonName,
      keyBinding,
    }))
    .sort((a, b) => a.scientificName.localeCompare(b.scientificName));
}

function hasDiff(diff: SpeciesDiff): boolean {
  return !!(diff.added.length || diff.removed.length || diff.modified.length);
}

function storedProfiles(): RevisionedKeyProfiles {
  return typeof localStorage === 'undefined' ? {} : readRevisionedProfiles(localStorage);
}

function latestProfiles(local: RevisionedKeyProfiles): RevisionedKeyProfiles {
  return mergeRevisionedProfiles(local, storedProfiles());
}

function commitProfiles(profiles: RevisionedKeyProfiles): RevisionedKeyProfiles {
  return typeof localStorage === 'undefined'
    ? profiles
    : mergeAndWriteRevisionedProfiles(localStorage, profiles);
}

function updateActiveProfile(
  state: KeyBindingState,
  update: (profile: RevisionedKeyProfile) => RevisionedKeyProfile,
): Partial<KeyBindingState> {
  if (!state.activeProfileId) return {};
  const profiles = latestProfiles(state.profiles);
  const profile = profiles[state.activeProfileId] ?? emptyRevisionedProfile();
  return {
    profiles: commitProfiles({
      ...profiles,
      [state.activeProfileId]: update(profile),
    }),
  };
}

export const useKeyBindings = create<KeyBindingState>()((set) => ({
  profiles: storedProfiles(),
  activeProfileId: null,
  activateProfile: (profileId) =>
    set((state) => {
      if (state.activeProfileId === profileId) return state;
      let profiles = latestProfiles(state.profiles);
      if (!profiles[profileId]) {
        const legacy = Object.keys(profiles).some((id) => id !== LEGACY_PROFILE)
          ? undefined
          : profiles[LEGACY_PROFILE];
        profiles = { ...profiles, [profileId]: legacy ?? emptyRevisionedProfile() };
        profiles = commitProfiles(profiles);
      }
      return { profiles, activeProfileId: profileId };
    }),
  assignKey: (scientificName, key, displacedScientificNames = []) =>
    set((state) =>
      updateActiveProfile(state, (profile) => {
        const overrides = { ...profile.overrides };
        const overrideRevisions = { ...profile.overrideRevisions };
        for (const displaced of displacedScientificNames) {
          if (displaced === scientificName) continue;
          overrides[displaced] = null;
          overrideRevisions[displaced] = nextKeyProfileRevision(
            profile.overrideRevisions[displaced],
          );
        }
        overrides[scientificName] = key;
        overrideRevisions[scientificName] = nextKeyProfileRevision(
          profile.overrideRevisions[scientificName],
        );
        return { ...profile, overrides, overrideRevisions };
      }),
    ),
  clearKey: (scientificName) =>
    set((state) =>
      updateActiveProfile(state, (profile) => ({
        ...profile,
        overrides: { ...profile.overrides, [scientificName]: null },
        overrideRevisions: {
          ...profile.overrideRevisions,
          [scientificName]: nextKeyProfileRevision(profile.overrideRevisions[scientificName]),
        },
      })),
    ),
  stageSpecies: (current) =>
    set((state) =>
      updateActiveProfile(state, (profile) => {
        const next = normalizedSpecies(current);
        if (!profile.acceptedSpecies) {
          return {
            ...profile,
            acceptedSpecies: next,
            acceptedRevision: nextKeyProfileRevision(profile.acceptedRevision),
          };
        }
        if (
          profile.pendingSpeciesChange &&
          JSON.stringify(profile.pendingSpeciesChange.next) === JSON.stringify(next)
        ) {
          return profile;
        }
        const diff = diffSpecies(profile.acceptedSpecies, next);
        return {
          ...profile,
          pendingSpeciesChange: hasDiff(diff) ? { next, diff } : undefined,
          pendingRevision: nextKeyProfileRevision(profile.pendingRevision),
        };
      }),
    ),
  acknowledgeSpeciesChange: () =>
    set((state) =>
      updateActiveProfile(state, (profile) => {
        const pending = profile.pendingSpeciesChange;
        if (!pending) return profile;
        const overrides = { ...profile.overrides };
        const overrideRevisions = { ...profile.overrideRevisions };
        for (const removed of pending.diff.removed) {
          overrides[removed.scientificName] = null;
          overrideRevisions[removed.scientificName] = nextKeyProfileRevision(
            profile.overrideRevisions[removed.scientificName],
          );
        }
        return {
          ...profile,
          overrides,
          overrideRevisions,
          acceptedSpecies: pending.next,
          acceptedRevision: nextKeyProfileRevision(profile.acceptedRevision),
          pendingSpeciesChange: undefined,
          pendingRevision: nextKeyProfileRevision(profile.pendingRevision),
        };
      }),
    ),
}));

export function activeKeyProfile(state: KeyBindingState): KeyProfile {
  return state.activeProfileId
    ? state.profiles[state.activeProfileId] ?? emptyRevisionedProfile()
    : emptyRevisionedProfile();
}

export function rehydrateKeyBindings(): void {
  useKeyBindings.setState((state) => ({
    profiles: commitProfiles(mergeRevisionedProfiles(state.profiles, storedProfiles())),
  }));
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEYBINDING_STORAGE_KEY) rehydrateKeyBindings();
  });
}
