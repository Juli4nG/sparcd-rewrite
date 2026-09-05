// Per-image corrected-time control in the Focus view (design §08). The corrected
// time is prominent; the original capture time is struck-through beneath it. A
// per-image override stacks on top of the upload offset and is stored in the
// draft's `timeOverride` (synced to `media.csv` col 4). Non-destructive — the
// original is never rewritten locally.

import { useState } from 'react';
import type { TimestampSource } from '@sparcd/camtrap';
import { normalizeTimestampInput } from '../lib/timeshift';

export function PerImageTime({
  original,
  corrected,
  hasUploadShift,
  overridden,
  timestampSource,
  onSet,
  onClear,
}: {
  original: string; // base capture time (media col 4)
  corrected: string; // resolved corrected time (offset + any override)
  hasUploadShift: boolean; // an upload-level offset is active
  overridden: boolean; // this image carries a per-image override
  timestampSource?: TimestampSource; // set when the camera wrote no time
  onSet: (iso: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(corrected);
  const [invalid, setInvalid] = useState(false);

  const open = () => {
    setText(corrected);
    setInvalid(false);
    setEditing(true);
  };

  const commit = () => {
    const iso = normalizeTimestampInput(text);
    if (!iso) {
      setInvalid(true);
      return;
    }
    onSet(iso);
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 border border-ink outline outline-2 outline-accent px-2 py-1 bg-paper min-w-0">
        <span className="font-mono text-[11px] text-inkSoft" aria-hidden>
          ◷
        </span>
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Corrected timestamp for this image"
          aria-invalid={invalid}
          spellCheck={false}
          autoFocus
          className={`bg-transparent border-none outline-none font-mono text-[13px] text-ink w-full sm:w-[160px] ${
            invalid ? 'text-warn' : ''
          }`}
          placeholder="YYYY-MM-DD HH:mm:ss"
        />
        <button
          onClick={commit}
          className="text-[11px] border border-ink bg-ink text-paper px-2 py-0.5 hover:bg-inkSoft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Set
        </button>
        <button
          onClick={() => setEditing(false)}
          className="text-[11px] border border-rule px-2 py-0.5 text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2.5 min-w-0">
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-[13.5px] font-[600] text-ink">
          {corrected || '— no timestamp —'}
          {overridden ? (
            <span className="ml-2 font-body text-[10px] font-[600] tracking-[0.08em] uppercase text-accent border border-accent px-1">
              image override
            </span>
          ) : (
            hasUploadShift && (
              <span className="ml-2 font-body text-[10px] font-[600] tracking-[0.08em] uppercase text-inkSoft border border-rule px-1">
                shifted
              </span>
            )
          )}
          {timestampSource && (
            <span
              className="ml-2 font-body text-[10px] font-[600] tracking-[0.08em] uppercase text-inkSoft border border-rule px-1"
              title={
                timestampSource === 'manual'
                  ? 'Entered by hand in the uploader.'
                  : 'Estimated by the uploader — the camera wrote no time. Set the real time here if you know it.'
              }
            >
              {timestampSource === 'manual' ? 'entered by hand' : 'estimated'}
            </span>
          )}
        </span>
        {corrected !== original && original && (
          <span className="font-mono text-[11px] text-inkMute line-through decoration-ruleSoft">
            was {original}
          </span>
        )}
      </span>
      <button
        onClick={open}
        className="text-[12px] border border-rule px-2.5 py-1 text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        Adjust time
      </button>
      {overridden && (
        <button
          onClick={onClear}
          className="text-[12px] text-inkMute hover:text-warn underline decoration-dotted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          title="Remove this image's override (fall back to the upload offset)"
        >
          clear override
        </button>
      )}
    </span>
  );
}
