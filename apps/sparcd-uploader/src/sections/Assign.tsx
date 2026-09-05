import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useOnline } from '@sparcd/auth-ui';
import { useStore } from '../store';
import { Spinner } from '../components/Spinner';
import { useLocations } from '../lib/useLocations';
import { useCollections, useCollectionDeployments } from '../lib/useCollections';
import { clearDiscovery } from '../lib/discoveryCache';
import { DeploymentPicker } from '../components/DeploymentPicker';
import { CollectionPicker } from '../components/CollectionPicker';
import { CaptureTimeEditor } from '../components/CaptureTimeEditor';
import { sanitizeUploaderUser } from '../lib/normalize';
import { supportedTimeZones } from '../lib/exifTime';
import { timeZoneForCoords } from '../lib/coords';

const sectionLabel =
  'font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft mb-2';

/** Section heading with a refresh control that re-pulls the backing S3 data,
 *  bypassing the query cache — for when the registry or a collection's
 *  deployments changed server-side mid-session. */
function RefreshableLabel({
  label,
  onRefresh,
  refreshing,
}: {
  label: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h2 className="font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft">{label}</h2>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label={`Refresh ${label.toLowerCase()} from S3`}
        title="Re-pull from S3"
        className="grid place-items-center min-w-6 min-h-6 border border-rule font-mono text-[12px] text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        {refreshing ? <Spinner /> : <span aria-hidden>↻</span>}
      </button>
    </div>
  );
}

function LocationsState({ message, tone }: { message: string; tone: 'mute' | 'warn' }) {
  return (
    <div
      className={`border px-3 py-2.5 font-body text-[13px] ${
        tone === 'warn' ? 'border-warn/40 text-warn bg-paper' : 'border-ruleSoft text-inkSoft bg-paper'
      }`}
    >
      {message}
    </div>
  );
}

export function Assign() {
  const s3Config = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const setStep = useStore((s) => s.setStep);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const setUploaderUser = useStore((s) => s.setUploaderUser);
  const description = useStore((s) => s.uploadDescription);
  const setDescription = useStore((s) => s.setUploadDescription);
  const uploadTimeZone = useStore((s) => s.uploadTimeZone);
  const setUploadTimeZone = useStore((s) => s.setUploadTimeZone);
  const selectedLocationKey = useStore((s) => s.selectedLocationKey);
  const setSelectedLocationKey = useStore((s) => s.setSelectedLocationKey);
  const selectedBucket = useStore((s) => s.selectedBucket);
  const setSelectedBucket = useStore((s) => s.setSelectedBucket);
  const elevationUnit = useStore((s) => s.elevationUnit);
  const files = useStore((s) => s.files);

  const {
    data,
    isLoading,
    isError,
    error,
    isFetching,
    refetch: refetchLocations,
  } = useLocations(s3Config, connectionId);
  const collections = useCollections(s3Config, connectionId);
  const slug = sanitizeUploaderUser(uploaderUser);

  const queryClient = useQueryClient();
  // Refresh means "ask the store again from scratch", so the remembered shape
  // goes too — but only the part this control refetches. The queries it kicks
  // off write their own field back on success; clearing the other one would
  // just leave the next warm connect with half a cache.
  const refreshCollections = () => {
    if (s3Config) clearDiscovery(s3Config, 'collections');
    void queryClient.invalidateQueries({ queryKey: ['collections'] });
  };
  const refreshDeployments = () => {
    // The settings bucket may have moved; drop the hint so it is re-searched
    // rather than confirmed from cache.
    if (s3Config) clearDiscovery(s3Config, 'settingsBucket');
    void queryClient.invalidateQueries({ queryKey: ['locations'] });
    void queryClient.invalidateQueries({ queryKey: ['collectionDeployments'] });
  };

  // Preselect the first collection the connected credentials can read.
  useEffect(() => {
    if (!collections.data?.length) return;
    if (selectedBucket && collections.data.some((c) => c.key === selectedBucket || c.bucket === selectedBucket)) {
      return;
    }
    setSelectedBucket(collections.data[0].key);
  }, [collections.data, selectedBucket, setSelectedBucket]);

  const collection =
    collections.data?.find((c) => c.key === selectedBucket || c.bucket === selectedBucket) ?? null;

  // Every location is assignable, not just ones this collection has already
  // deployed — but the ones it has already deployed (derived from its uploads'
  // deployments.csv) are listed first, since they're the likely picks.
  const deployments = useCollectionDeployments(s3Config, connectionId, collection);

  // react-query pauses a query's in-flight fetch while offline and resumes it
  // automatically on reconnect (default `networkMode: 'online'`) — but a
  // query that already exhausted its retry and settled into an error state
  // before this step was even reached (e.g. offline from the start, or the
  // failure happened before this transition was ever observed) needs an
  // explicit nudge rather than relying on that pause ever having happened.
  const online = useOnline();
  const wasOffline = useRef(!online);
  useEffect(() => {
    if (online && wasOffline.current) {
      void refetchLocations();
      void collections.refetch();
      if (collection) void deployments.refetch();
    }
    wasOffline.current = !online;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const usedLocationCount = useMemo(
    () => new Set(deployments.data ?? []).size,
    [deployments.data],
  );
  const collectionLocations = useMemo(() => {
    if (!data?.locations || !deployments.data) return [];
    const used = new Set(deployments.data);
    const already = data.locations.filter((l) => used.has(l.id));
    const rest = data.locations.filter((l) => !used.has(l.id));
    return [...already, ...rest];
  }, [data?.locations, deployments.data]);

  const location = collectionLocations.find((l) => l.key === selectedLocationKey) ?? null;

  // Picking a deployment implies a zone — the camera's naive EXIF wall-clock
  // needs to be interpreted in wherever it physically sits, not the browser's
  // zone. Fires only when the *selection* changes, so a manual override the
  // user makes afterward for the same location sticks. The mount-time run is
  // special-cased: uploadTimeZone/selectedLocationKey are both restored from
  // sessionStorage before this component ever renders, so if the location on
  // mount is the same one that was already selected, re-deriving here would
  // clobber a manual override that survived the reload.
  const mountedLocationKeyRef = useRef(selectedLocationKey);
  const isFirstLocationEffect = useRef(true);
  useEffect(() => {
    if (!location) return;
    if (isFirstLocationEffect.current) {
      isFirstLocationEffect.current = false;
      if (location.key === mountedLocationKeyRef.current) return;
    }
    setUploadTimeZone(timeZoneForCoords(location.latitude, location.longitude));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.key]);

  const needsCaptureTime = files.some(
    (f) => f.processState === 'ready' && !f.exifNaive,
  );
  // Gate is everything the USER needs to supply — deployment, collection,
  // identity, and a capture time for whatever's finished Inspect so far.
  // Background processing finishing is no longer part of this gate: Upload
  // streams blobs as files individually become ready and only publishes once
  // processing genuinely completes, so there's nothing to wait for here.
  const baseReady = !!selectedLocationKey && !!slug && !!collection;

  function handleContinue() {
    if (!baseReady) return;
    setStep('upload');
  }

  // The chosen zone is always offered even if it isn't in the platform's list.
  const timeZones = useMemo(() => {
    const all = supportedTimeZones();
    return all.includes(uploadTimeZone) ? all : [uploadTimeZone, ...all];
  }, [uploadTimeZone]);

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <OfflineBanner message="You're offline — locations and collections won't load until your connection is back." />
      <section>
        <RefreshableLabel
          label="Target collection"
          onRefresh={refreshCollections}
          refreshing={collections.isFetching}
        />
        {collections.isLoading && <LocationsState tone="mute" message="Discovering collections…" />}
        {collections.isError && (
          <LocationsState
            tone="warn"
            message={(collections.error as Error)?.message ?? 'Could not list collections.'}
          />
        )}
        {collections.data && (
          <div className="space-y-1.5">
            {collections.data.length === 0 ? (
              <LocationsState
                tone="warn"
                message="No collections found. The connected credentials must be able to read Collections/<uuid>/collection.json in a sparcd-<uuid> bucket, and that bucket must allow this web origin via CORS."
              />
            ) : (
              <>
                <CollectionPicker
                  collections={collections.data}
                  value={selectedBucket}
                  onChange={(key) => setSelectedBucket(key)}
                />
                {collection && (
                  <p className="font-body text-[12px] text-inkMute">
                    <span className="text-inkSoft">{collection.name ?? 'Unnamed collection'}</span> ·{' '}
                    <span className="font-mono">{collection.uuid}</span>
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      <section>
        <RefreshableLabel
          label="Deployment"
          onRefresh={refreshDeployments}
          refreshing={isFetching || deployments.isFetching}
        />
        {(isLoading || (collection && deployments.isLoading)) && (
          <LocationsState tone="mute" message="Loading this collection's deployments…" />
        )}
        {isError && (
          <LocationsState
            tone="warn"
            message={(error as Error)?.message ?? 'Could not load locations.'}
          />
        )}
        {data && deployments.isError && (
          <LocationsState
            tone="warn"
            message={(deployments.error as Error)?.message ?? 'Could not read this collection’s deployments.'}
          />
        )}
        {data && !collection && (
          <LocationsState tone="mute" message="Select a target collection first." />
        )}
        {data && collection && deployments.data && (
          <div className="space-y-2">
            {collectionLocations.length === 0 ? (
              <LocationsState tone="warn" message="No locations found in this connection's registry." />
            ) : (
              <DeploymentPicker
                locations={collectionLocations}
                value={selectedLocationKey}
                onChange={setSelectedLocationKey}
                elevationUnit={elevationUnit}
              />
            )}
            <p className="font-body text-[12px] text-inkMute">
              <span className="font-mono text-inkSoft">{usedLocationCount}</span> of{' '}
              <span className="font-mono text-inkSoft">{collectionLocations.length}</span> locations
              already deployed by <span className="text-inkSoft">{collection.name ?? 'this collection'}</span> —
              listed first, but any location can be assigned.
            </p>
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionLabel}>Uploader</h2>
        <input
          id="uploaderUser"
          name="uploaderUser"
          autoComplete="name"
          value={uploaderUser}
          onChange={(e) => setUploaderUser(e.target.value)}
          placeholder="e.g. John Doe"
          className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        />
        <p className="font-body text-[12px] text-inkMute mt-1.5">
          Defaults to your access key unless you set one in Settings.
        </p>
      </section>

      <section>
        <h2 className={sectionLabel}>Timezone</h2>
        <select
          value={uploadTimeZone}
          onChange={(e) => setUploadTimeZone(e.target.value)}
          className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          {timeZones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <p className="font-body text-[12px] text-inkMute mt-1.5">
          Defaults to the selected deployment location's zone — change it here if the camera's
          clock was actually set to a different one.
        </p>
      </section>

      {needsCaptureTime && (
        <section>
          <h2 className={sectionLabel}>Capture times</h2>
          <CaptureTimeEditor files={files} />
        </section>
      )}

      <section>
        <h2 className={sectionLabel}>Description</h2>
        <textarea
          id="uploadDescription"
          name="uploadDescription"
          autoComplete="on"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What this batch is — site, date range, notes."
          className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        />
        <p className="font-body text-[12px] text-inkMute mt-1.5">
          Mountain Range - Site Name - No. of images collected - Date Uploaded - Date collected
        </p>
        <p className="font-body text-[12px] text-inkMute">
          (e.g.: Santa Rita Mountains - SAN06 - 39 images - uploaded 04-10-2020 - collected 03-28-2000)
        </p>
      </section>

      <div className="flex items-center justify-between gap-4 border-t border-ruleSoft pt-5">
        <button
          onClick={() => setStep('inspect')}
          className="border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          Back
        </button>
        <button
          disabled={!baseReady}
          onClick={handleContinue}
          title={
            !baseReady
              ? !selectedLocationKey
                ? 'Select a deployment location first'
                : !collection
                  ? 'Select a target collection first'
                  : 'Set an uploader identity first'
              : 'Continue to upload'
          }
          className={`bg-ink text-paper border border-ink px-3.5 py-1.5 text-[14px] font-body font-[600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
            baseReady ? 'hover:opacity-90' : 'opacity-40 cursor-not-allowed'
          }`}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
