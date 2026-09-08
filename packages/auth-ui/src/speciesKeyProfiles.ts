export const KEYBINDING_STORAGE_KEY = 'sparcd-tagger-keybindings';
export const KEYBINDING_STORAGE_VERSION = 3;

export type SpeciesKeyConfig = {
  scientificName: string;
  commonName: string;
  keyBinding: string | null;
};

export type SpeciesDiff = {
  added: SpeciesKeyConfig[];
  removed: SpeciesKeyConfig[];
  modified: { before: SpeciesKeyConfig; after: SpeciesKeyConfig }[];
};

export type PendingSpeciesChange = { next: SpeciesKeyConfig[]; diff: SpeciesDiff };

export type Revision = { at: number; sequence: number; writer: string };

export type Revisioned<T> = { value: T; revision: Revision };

export type RevisionedKeyProfile = {
  overrides: Record<string, string | null>;
  overrideRevisions: Record<string, Revision>;
  acceptedSpecies?: SpeciesKeyConfig[];
  acceptedRevision?: Revision;
  pendingSpeciesChange?: PendingSpeciesChange;
  pendingRevision?: Revision;
};

export type RevisionedKeyProfiles = Record<string, RevisionedKeyProfile>;

type PersistedEnvelope = {
  state: { profiles: RevisionedKeyProfiles };
  version: number;
};

const LEGACY_REVISION: Revision = { at: 0, sequence: 0, writer: 'legacy' };
const WRITER_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `writer-${Math.random().toString(36).slice(2)}`;
let revisionSequence = 0;

export function nextKeyProfileRevision(...observed: (Revision | undefined)[]): Revision {
  revisionSequence += 1;
  const observedAt = Math.max(0, ...observed.map((revision) => revision?.at ?? 0));
  return {
    at: Math.max(Date.now(), observedAt + 1),
    sequence: revisionSequence,
    writer: WRITER_ID,
  };
}

function compareRevision(a?: Revision, b?: Revision): number {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return a.at - b.at || a.sequence - b.sequence || a.writer.localeCompare(b.writer);
}

function newer<T>(
  aValue: T | undefined,
  aRevision: Revision | undefined,
  bValue: T | undefined,
  bRevision: Revision | undefined,
): { value: T | undefined; revision: Revision | undefined } {
  return compareRevision(aRevision, bRevision) >= 0
    ? { value: aValue, revision: aRevision }
    : { value: bValue, revision: bRevision };
}

export function emptyRevisionedProfile(): RevisionedKeyProfile {
  return { overrides: {}, overrideRevisions: {} };
}

export function mergeRevisionedProfile(
  a: RevisionedKeyProfile | undefined,
  b: RevisionedKeyProfile | undefined,
): RevisionedKeyProfile {
  if (!a) return b ?? emptyRevisionedProfile();
  if (!b) return a;
  const overrides: Record<string, string | null> = {};
  const overrideRevisions: Record<string, Revision> = {};
  const names = new Set([
    ...Object.keys(a.overrides),
    ...Object.keys(b.overrides),
    ...Object.keys(a.overrideRevisions),
    ...Object.keys(b.overrideRevisions),
  ]);
  for (const name of names) {
    const selected = newer(
      a.overrides[name],
      a.overrideRevisions[name] ?? (name in a.overrides ? LEGACY_REVISION : undefined),
      b.overrides[name],
      b.overrideRevisions[name] ?? (name in b.overrides ? LEGACY_REVISION : undefined),
    );
    if (selected.revision) {
      overrides[name] = selected.value ?? null;
      overrideRevisions[name] = selected.revision;
    }
  }
  const accepted = newer(
    a.acceptedSpecies,
    a.acceptedRevision ?? (a.acceptedSpecies ? LEGACY_REVISION : undefined),
    b.acceptedSpecies,
    b.acceptedRevision ?? (b.acceptedSpecies ? LEGACY_REVISION : undefined),
  );
  const pending = newer(
    a.pendingSpeciesChange,
    a.pendingRevision,
    b.pendingSpeciesChange,
    b.pendingRevision,
  );
  return {
    overrides,
    overrideRevisions,
    ...(accepted.value ? { acceptedSpecies: accepted.value } : {}),
    ...(accepted.revision ? { acceptedRevision: accepted.revision } : {}),
    ...(pending.value ? { pendingSpeciesChange: pending.value } : {}),
    ...(pending.revision ? { pendingRevision: pending.revision } : {}),
  };
}

export function mergeRevisionedProfiles(
  a: RevisionedKeyProfiles,
  b: RevisionedKeyProfiles,
): RevisionedKeyProfiles {
  const merged: RevisionedKeyProfiles = {};
  for (const profileId of new Set([...Object.keys(a), ...Object.keys(b)])) {
    merged[profileId] = mergeRevisionedProfile(a[profileId], b[profileId]);
  }
  // The unscoped profile exists only long enough to migrate pre-profile data.
  // Once any endpoint/user profile has claimed it, never let a stale tab bring
  // it back or make tests/callers accidentally select it as an active profile.
  if (Object.keys(merged).some((profileId) => profileId !== '__legacy__')) {
    delete merged.__legacy__;
  }
  return merged;
}

function migrateProfile(raw: unknown): RevisionedKeyProfile {
  const profile = (raw ?? {}) as Partial<RevisionedKeyProfile>;
  const overrides = Object.fromEntries(
    Object.entries(profile.overrides ?? {}).map(([name, key]) => [name, key === '' ? null : key]),
  );
  return {
    overrides,
    overrideRevisions: {
      ...Object.fromEntries(Object.keys(overrides).map((name) => [name, LEGACY_REVISION])),
      ...(profile.overrideRevisions ?? {}),
    },
    ...(profile.acceptedSpecies ? { acceptedSpecies: profile.acceptedSpecies } : {}),
    ...(profile.acceptedRevision
      ? { acceptedRevision: profile.acceptedRevision }
      : profile.acceptedSpecies
        ? { acceptedRevision: LEGACY_REVISION }
        : {}),
    ...(profile.pendingSpeciesChange
      ? { pendingSpeciesChange: profile.pendingSpeciesChange }
      : {}),
    ...(profile.pendingRevision
      ? { pendingRevision: profile.pendingRevision }
      : profile.pendingSpeciesChange
        ? { pendingRevision: LEGACY_REVISION }
        : {}),
  };
}

export function parseRevisionedProfiles(raw: string | null): RevisionedKeyProfiles {
  if (!raw) return {};
  try {
    const envelope = JSON.parse(raw) as {
      state?: {
        profiles?: Record<string, unknown>;
        overrides?: Record<string, string | null>;
        knownSpecies?: string[];
      };
    };
    if (envelope.state?.profiles) {
      return Object.fromEntries(
        Object.entries(envelope.state.profiles).map(([id, profile]) => [id, migrateProfile(profile)]),
      );
    }
    const acceptedSpecies = envelope.state?.knownSpecies?.map((scientificName) => ({
      scientificName,
      commonName: scientificName,
      keyBinding: null,
    }));
    return {
      __legacy__: migrateProfile({
        overrides: envelope.state?.overrides ?? {},
        acceptedSpecies,
      }),
    };
  } catch {
    return {};
  }
}

export function serializeRevisionedProfiles(profiles: RevisionedKeyProfiles): string {
  const orderedProfiles = Object.fromEntries(
    Object.entries(profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([profileId, profile]) => [
        profileId,
        {
          ...profile,
          overrides: Object.fromEntries(
            Object.entries(profile.overrides).sort(([a], [b]) => a.localeCompare(b)),
          ),
          overrideRevisions: Object.fromEntries(
            Object.entries(profile.overrideRevisions).sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
      ]),
  );
  const envelope: PersistedEnvelope = {
    state: { profiles: orderedProfiles },
    version: KEYBINDING_STORAGE_VERSION,
  };
  return JSON.stringify(envelope);
}

export function readRevisionedProfiles(storage: Storage): RevisionedKeyProfiles {
  return parseRevisionedProfiles(storage.getItem(KEYBINDING_STORAGE_KEY));
}

export function pendingRevisionedSpeciesProfile(
  storage: Storage,
  profileId: string,
): SpeciesDiff | null {
  return readRevisionedProfiles(storage)[profileId]?.pendingSpeciesChange?.diff ?? null;
}

/** Restored sessions start at connection revision zero. Login events, including
 * a live login relayed from another tab, increment it before the gate mounts. */
export function shouldReconcileSpeciesProfile(
  connectionId: number,
  isLocalBatch = false,
): boolean {
  return isLocalBatch || connectionId > 0;
}

export function mergeAndWriteRevisionedProfiles(
  storage: Storage,
  local: RevisionedKeyProfiles,
): RevisionedKeyProfiles {
  const merged = mergeRevisionedProfiles(readRevisionedProfiles(storage), local);
  const serialized = serializeRevisionedProfiles(merged);
  if (storage.getItem(KEYBINDING_STORAGE_KEY) !== serialized) {
    storage.setItem(KEYBINDING_STORAGE_KEY, serialized);
  }
  return merged;
}

export function keyProfileId(endpoint: string, accessKey: string): string {
  return `${endpoint.trim()}\u0000${accessKey.trim()}`;
}

function normalizeSpecies(species: readonly SpeciesKeyConfig[]): SpeciesKeyConfig[] {
  return species
    .map(({ scientificName, commonName, keyBinding }) => ({ scientificName, commonName, keyBinding }))
    .sort((a, b) => a.scientificName.localeCompare(b.scientificName));
}

export function diffRevisionedSpecies(
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

function profileForMutation(
  profiles: RevisionedKeyProfiles,
  profileId: string,
): RevisionedKeyProfile {
  if (profiles[profileId]) return profiles[profileId];
  const hasClaimedLegacy = Object.keys(profiles).some((id) => id !== '__legacy__');
  return !hasClaimedLegacy && profiles.__legacy__
    ? profiles.__legacy__
    : emptyRevisionedProfile();
}

export function stageRevisionedSpeciesProfile(
  storage: Storage,
  profileId: string,
  species: readonly SpeciesKeyConfig[],
): SpeciesDiff | null {
  const profiles = readRevisionedProfiles(storage);
  const profile = profileForMutation(profiles, profileId);
  const next = normalizeSpecies(species);
  let updated: RevisionedKeyProfile;
  if (!profile.acceptedSpecies) {
    updated = {
      ...profile,
      acceptedSpecies: next,
      acceptedRevision: nextKeyProfileRevision(profile.acceptedRevision),
    };
  } else {
    const diff = diffRevisionedSpecies(profile.acceptedSpecies, next);
    const pendingSpeciesChange =
      diff.added.length || diff.removed.length || diff.modified.length ? { next, diff } : undefined;
    updated = {
      ...profile,
      pendingSpeciesChange,
      pendingRevision: nextKeyProfileRevision(profile.pendingRevision),
    };
  }
  const merged = mergeAndWriteRevisionedProfiles(storage, { ...profiles, [profileId]: updated });
  return merged[profileId].pendingSpeciesChange?.diff ?? null;
}

export function acknowledgeRevisionedSpeciesProfile(storage: Storage, profileId: string): void {
  const profiles = readRevisionedProfiles(storage);
  const profile = profileForMutation(profiles, profileId);
  const pending = profile.pendingSpeciesChange;
  if (!pending) return;
  const overrides = { ...profile.overrides };
  const overrideRevisions = { ...profile.overrideRevisions };
  for (const removed of pending.diff.removed) {
    overrides[removed.scientificName] = null;
    overrideRevisions[removed.scientificName] = nextKeyProfileRevision(
      profile.overrideRevisions[removed.scientificName],
    );
  }
  mergeAndWriteRevisionedProfiles(storage, {
    ...profiles,
    [profileId]: {
      ...profile,
      overrides,
      overrideRevisions,
      acceptedSpecies: pending.next,
      acceptedRevision: nextKeyProfileRevision(profile.acceptedRevision),
      pendingSpeciesChange: undefined,
      pendingRevision: nextKeyProfileRevision(profile.pendingRevision),
    },
  });
}
