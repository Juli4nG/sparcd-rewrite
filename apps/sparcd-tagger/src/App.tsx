import { useEffect } from 'react';
import { Connection, loadPersistedConnection } from '@sparcd/auth-ui';
import { useStore } from './store';
import { Chrome } from './components/Chrome';
import { Browse } from './sections/Browse';
import { Tag } from './sections/Tag';
import { Settings } from './sections/Settings';
import { Recovery } from './sections/Recovery';
import { Placeholder } from './sections/Placeholder';
import { localBatchId, useLocalBatch } from './lib/localBatch';
import { SpeciesKeyBindingGate } from './components/SpeciesKeyBindingGate';

// Dev-only, non-secret prefill (endpoint only). Secrets are never prefilled.
const devEndpoint = import.meta.env.VITE_SPARCD_S3_ENDPOINT as string | undefined;

// The remembered non-secret fields (endpoint/access key/region/etc.) from a
// prior connection, if any — the secret itself is never persisted, so the
// user always retypes it. Read once; a dev endpoint override wins if set.
const persistedConnection = loadPersistedConnection();
const connectPrefill = { ...persistedConnection, ...(devEndpoint ? { endpoint: devEndpoint } : {}) };

export function App() {
  const s3Config = useStore((s) => s.s3Config);
  const section = useStore((s) => s.section);
  const connect = useStore((s) => s.connect);
  const theme = useStore((s) => s.theme);
  const selectedUploadPrefix = useStore((s) => s.selectedUploadPrefix);
  const localStatus = useLocalBatch((s) => s.status);
  const loadLocalBatch = useLocalBatch((s) => s.load);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (localBatchId) void loadLocalBatch();
  }, [loadLocalBatch]);

  // A local batch is images that are not in any collection yet, so there is
  // nothing to connect to and the login gate would be a lie. The workspace
  // opens straight onto the record instead.
  if (localBatchId) {
    if (localStatus === 'loading') return <LocalBatchBoot />;
    if (localStatus === 'missing') return <LocalBatchMissing />;
    return (
      <SpeciesKeyBindingGate>
        <Chrome>
          <Tag />
        </Chrome>
      </SpeciesKeyBindingGate>
    );
  }

  if (!s3Config) {
    return (
      <Connection toolName="Tagger" initialConfig={connectPrefill} onConnect={connect} />
    );
  }

  return (
    <SpeciesKeyBindingGate>
      <Chrome>
        {section === 'browse' && <Browse />}
        {section === 'tag' &&
          (selectedUploadPrefix ? (
            <Tag />
          ) : (
            <Placeholder title="Tag workspace" phase="P1 – P3">
              Choose an upload in Browse to start tagging.
            </Placeholder>
          ))}
        {section === 'history' && <Recovery />}
        {section === 'settings' && <Settings />}
      </Chrome>
    </SpeciesKeyBindingGate>
  );
}

function LocalBatchBoot() {
  return (
    <div className="h-[100dvh] bg-paper grid place-items-center">
      <p className="font-body text-[15px] text-inkMute">Opening the batch…</p>
    </div>
  );
}

// The two tools share a record only because they share an origin. In
// development they don't — the uploader is on one dev server and the tagger on
// another — so this is the expected view when a hand-off is tried there.
function LocalBatchMissing() {
  return (
    <div className="h-[100dvh] bg-paper grid place-items-center px-6">
      <div className="border border-rule bg-panel px-6 py-8 max-w-[560px] space-y-4">
        <h1 className="font-display text-[20px] font-[600] text-ink">No such batch</h1>
        <p className="font-body text-[14px] text-inkSoft">
          This browser has no record of the batch in the link. Batches live in local storage that
          the Uploader and the Tagger share only when they are served from the same origin — in
          development they aren't. Nothing was lost: the batch is still in the Uploader.
        </p>
      </div>
    </div>
  );
}
