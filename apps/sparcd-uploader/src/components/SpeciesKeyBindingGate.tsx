import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { fetchSpeciesKeyConfig, type SpeciesKeyConfig } from '../lib/s3';
import {
  acknowledgeSpeciesProfile,
  pendingSpeciesProfile,
  shouldReconcileSpeciesProfile,
  speciesKeyProfileId,
  stageSpeciesProfile,
} from '../lib/speciesKeyProfiles';

type Diff = {
  added: SpeciesKeyConfig[];
  removed: SpeciesKeyConfig[];
  modified: { before: SpeciesKeyConfig; after: SpeciesKeyConfig }[];
};

export function SpeciesKeyBindingGate({ children }: { children: ReactNode }) {
  const cfg = useStore((state) => state.s3Config);
  const connectionId = useStore((state) => state.connectionId);
  const [diff, setDiff] = useState<Diff | null>(null);
  const profileId = cfg ? speciesKeyProfileId(cfg.endpoint, cfg.accessKey) : null;

  useEffect(() => {
    let cancelled = false;
    if (!cfg || !profileId) return;
    setDiff(pendingSpeciesProfile(localStorage, profileId));
    if (!shouldReconcileSpeciesProfile(connectionId)) return;
    void fetchSpeciesKeyConfig(cfg).then(
      (species) => {
        if (!cancelled) setDiff(stageSpeciesProfile(localStorage, profileId, species));
      },
      () => {
        // Species settings are not required for uploading. The Tagger surfaces
        // its existing actionable read error if this optional preflight fails.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cfg, connectionId, profileId]);

  const acknowledge = () => {
    if (!profileId) return;
    acknowledgeSpeciesProfile(localStorage, profileId);
    setDiff(null);
  };

  return (
    <>
      {children}
      {diff && <SpeciesChangedNotice diff={diff} onAcknowledge={acknowledge} />}
    </>
  );
}

function SpeciesChangedNotice({ diff, onAcknowledge }: { diff: Diff; onAcknowledge: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    buttonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Tab') {
        event.preventDefault();
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previousFocus?.focus();
    };
  }, []);

  const rows = [
    ...diff.added.map((entry) => `Added: ${entry.commonName}`),
    ...diff.removed.map((entry) => `Removed: ${entry.commonName}`),
    ...diff.modified.map((entry) => `Updated: ${entry.after.commonName}`),
  ];

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-6">
      <div role="alertdialog" aria-modal="true" aria-label="Species vocabulary has changed" className="w-full max-w-md border border-rule bg-panel p-5 shadow-lg">
        <h2 className="font-display text-[20px] font-[600] text-ink">Species vocabulary has changed</h2>
        <p className="mt-2 text-[13px] text-inkSoft">Your saved species key configuration will be updated after you acknowledge these server changes.</p>
        <ul className="mt-4 space-y-1 font-mono text-[13px] text-ink">
          {rows.map((row) => <li key={row}>{row}</li>)}
        </ul>
        <div className="mt-5 flex justify-end">
          <button ref={buttonRef} type="button" onClick={onAcknowledge} className="min-h-11 border border-ink px-4 text-[13px] font-[600] text-ink">
            I understand
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
