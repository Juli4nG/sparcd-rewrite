import { useEffect, useMemo, type ReactNode } from 'react';
import { shouldReconcileSpeciesProfile } from '@sparcd/auth-ui';
import { useStore } from '../store';
import { useLocalBatch } from '../lib/localBatch';
import { useSpecies } from '../lib/queries';
import { DEFAULT_SPECIES } from '../lib/defaultSpecies';
import {
  activeKeyProfile,
  keyProfileId,
  useKeyBindings,
  type SpeciesKeyConfig,
} from '../lib/keys';
import { SpeciesChangedModal } from './SpeciesChangedModal';

function keyConfig(
  species: readonly {
    scientificName: string;
    commonName: string;
    keyBinding: string | null;
  }[],
): SpeciesKeyConfig[] {
  return species.map(({ scientificName, commonName, keyBinding }) => ({
    scientificName,
    commonName,
    keyBinding,
  }));
}

/** Activates the user's keybinding profile and reconciles vocabulary changes
 * as soon as the app has a species list, before the user enters Tag. */
export function SpeciesKeyBindingGate({ children }: { children: ReactNode }) {
  const cfg = useStore((state) => state.s3Config);
  const connectionId = useStore((state) => state.connectionId);
  const localRecord = useLocalBatch((state) => (state.status === 'ready' ? state.record : null));
  const species = useSpecies(cfg, connectionId);
  const activeProfileId = useKeyBindings((state) => state.activeProfileId);
  const activateProfile = useKeyBindings((state) => state.activateProfile);
  const stageSpecies = useKeyBindings((state) => state.stageSpecies);
  const acknowledgeSpeciesChange = useKeyBindings(
    (state) => state.acknowledgeSpeciesChange,
  );

  const profileId = cfg
    ? keyProfileId(cfg.endpoint, cfg.accessKey)
    : localRecord
      ? keyProfileId('local-batch', localRecord.taggerUser || 'anonymous')
      : null;
  const pending = useKeyBindings((state) =>
    state.activeProfileId === profileId
      ? activeKeyProfile(state).pendingSpeciesChange
      : undefined,
  );
  const currentSpecies = useMemo(
    () =>
      cfg
        ? species.data
          ? keyConfig(species.data.species)
          : null
        : localRecord
          ? keyConfig(DEFAULT_SPECIES)
          : null,
    [cfg, localRecord, species.data],
  );

  useEffect(() => {
    if (profileId) activateProfile(profileId);
  }, [activateProfile, profileId]);

  useEffect(() => {
    if (!shouldReconcileSpeciesProfile(connectionId, !!localRecord)) return;
    if (profileId === activeProfileId && currentSpecies) stageSpecies(currentSpecies);
  }, [activeProfileId, connectionId, currentSpecies, localRecord, profileId, stageSpecies]);

  return (
    <>
      {children}
      {pending && (
        <SpeciesChangedModal
          added={pending.diff.added.map((entry) => entry.commonName)}
          removed={pending.diff.removed.map((entry) => entry.commonName)}
          modified={pending.diff.modified.map((entry) => entry.after.commonName)}
          onAcknowledge={acknowledgeSpeciesChange}
        />
      )}
    </>
  );
}
