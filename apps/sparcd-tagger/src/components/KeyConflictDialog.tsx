import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  keyName: string;
  targetName: string;
  ownerNames: string[];
  onConfirm: () => void;
  onCancel: () => void;
};

export function KeyConflictDialog({
  keyName,
  targetName,
  ownerNames,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        if (document.activeElement === confirmRef.current) cancelRef.current?.focus();
        else confirmRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="key-conflict-title"
        aria-describedby="key-conflict-description"
        className="w-full max-w-md border-2 border-warn bg-paper p-5 shadow-xl"
      >
        <h2 id="key-conflict-title" className="font-display text-[20px] font-[600] text-ink">
          Key already assigned
        </h2>
        <p id="key-conflict-description" className="mt-3 text-[14px] text-ink">
          <kbd className="border border-ink px-1.5 font-mono">{keyName}</kbd> is already assigned
          to {ownerNames.join(', ')}. Reassign it to {targetName}?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="min-h-11 border border-rule px-4 text-[13px] text-ink">
            Cancel
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} className="min-h-11 border border-warn bg-warn px-4 text-[13px] font-[600] text-ink">
            Reassign key
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
