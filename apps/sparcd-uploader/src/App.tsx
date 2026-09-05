import { useEffect } from 'react';
import { Connection, loadPersistedConnection } from '@sparcd/auth-ui';
import { useStore } from './store';
import './lib/streamingBridge';
import { Chrome } from './components/Chrome';
import { NewUpload } from './sections/NewUpload';
import { History } from './sections/History';
import { Settings } from './sections/Settings';
import { uploadStateOf } from './lib/uploadState';
import { cancelProcessing } from './lib/processing';

// Dev-only, non-secret prefill (endpoint only). Secrets are never prefilled.
const devEndpoint = import.meta.env.VITE_SPARCD_S3_ENDPOINT as string | undefined;

// The remembered non-secret fields (endpoint/access key/region/etc.) from a
// prior connection, if any — the secret itself is never persisted, so the
// user always retypes it. Read once; a dev endpoint override wins if set.
const persistedConnection = loadPersistedConnection();
const connectPrefill = { ...persistedConnection, ...(devEndpoint ? { endpoint: devEndpoint } : {}) };

export function App() {
  const s3Config = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const section = useStore((s) => s.section);
  const connect = useStore((s) => s.connect);
  const theme = useStore((s) => s.theme);
  const activeSnap = useStore((s) => s.activeSnap);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    cancelProcessing();
  }, [connectionId]);

  // Warn on tab close/reload while any real run (fresh or resume) is in flight.
  // Lives here rather than in the section components so it covers History resume
  // runs too — both sections write into the same store activeSnap.
  const activelyRunning =
    activeSnap?.phase === 'preparing' ||
    activeSnap?.phase === 'blobs' ||
    activeSnap?.phase === 'metadata';
  const runningForReal = activelyRunning && !activeSnap?.dryRun;
  useEffect(() => {
    if (!runningForReal) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [runningForReal]);

  // Hold a screen wake lock while any run is in flight (including dry runs and
  // the preparing phase). Lives here (not in Upload) so it survives the user
  // navigating away mid-upload. The lock is auto-released by the browser on tab
  // hide, so it's re-acquired on regaining visibility. Generation counter guards
  // against orphaned sentinels when two visibility events fire before either
  // acquire() resolves.
  useEffect(() => {
    if (!activelyRunning || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    let gen = 0;

    const acquire = () => {
      const myGen = ++gen;
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled || myGen !== gen) {
            void l.release();
          } else {
            lock = l;
          }
        })
        .catch(() => {});
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void lock?.release();
      lock = null;
      acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void lock?.release();
    };
  }, [activelyRunning]);

  if (!s3Config) {
    return (
      <Connection toolName="Uploader" initialConfig={connectPrefill} onConnect={connect} />
    );
  }

  return (
    <Chrome uploadState={uploadStateOf(activeSnap)}>
      {section === 'new' && <NewUpload />}
      {section === 'history' && <History />}
      {section === 'settings' && <Settings />}
    </Chrome>
  );
}
