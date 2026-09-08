import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  added: string[];
  removed: string[];
  modified: string[];
  onAcknowledge: () => void;
};

export function SpeciesChangedModal({ added, removed, modified, onAcknowledge }: Props) {
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    acknowledgeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key !== 'Tab') return;
      e.preventDefault();
      acknowledgeRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6"
      role="alertdialog"
      aria-modal="true"
      aria-label="Species vocabulary has changed"
    >
      <div className="w-full max-w-md bg-panel border border-rule shadow-lg">
        <div className="px-5 py-4 border-b border-rule">
          <div className="text-[15px] font-[600] text-ink">Species vocabulary has changed</div>
          <div className="mt-1 text-[13px] font-body text-inkSoft">
            The species list on the server has been updated since your last session.
            Your saved key assignments have been updated to match.
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {added.length > 0 && (
            <section>
              <div className="text-[11px] font-[600] tracking-[0.12em] uppercase text-inkSoft mb-1.5">
                Added ({added.length})
              </div>
              <ul className="space-y-0.5">
                {added.map((s) => (
                  <li key={s} className="text-[13px] font-mono text-ink">
                    + {s}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {removed.length > 0 && (
            <section>
              <div className="text-[11px] font-[600] tracking-[0.12em] uppercase text-inkSoft mb-1.5">
                Removed ({removed.length})
              </div>
              <ul className="space-y-0.5">
                {removed.map((s) => (
                  <li key={s} className="text-[13px] font-mono text-inkMute">
                    − {s}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {modified.length > 0 && (
            <section>
              <div className="text-[11px] font-[600] tracking-[0.12em] uppercase text-inkSoft mb-1.5">
                Updated ({modified.length})
              </div>
              <ul className="space-y-0.5">
                {modified.map((s) => (
                  <li key={s} className="text-[13px] font-mono text-ink">
                    ~ {s}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="px-5 py-3 border-t border-rule flex justify-end">
          <button
            ref={acknowledgeRef}
            type="button"
            onClick={onAcknowledge}
            className="text-[13px] font-mono border border-ink px-4 py-1.5 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            I understand
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
