import { Given, When, Then, expect } from './fixtures';
import type { App, FileSpec } from './app';
import { FOLDER, jpegAt, publishableBatch, slowPublishableBatch } from './batches';
import { BUCKET_A, UUID_A } from './fixtures-data';
import { FAILING_FILE, producePartialRun as basePartialRun, writtenCsvRows } from './helpers';

const UPLOADS_PREFIX = `Collections/${UUID_A}/Uploads/`;
const METADATA_NAMES = ['deployments.csv', 'media.csv', 'observations.csv', 'UploadMeta.json', 'UploadComplete.json'];

const metadataPuts = (app: App) =>
  app.s3.puts.filter((p) => METADATA_NAMES.some((n) => p.key.endsWith(n)));
const mediaPuts = (app: App) =>
  app.s3.puts.filter((p) => !METADATA_NAMES.some((n) => p.key.endsWith(n)));

function holdFirstMediaPut(app: App): void {
  let held = false;
  app.s3.holdPut = (_bucket, key) => {
    if (held || METADATA_NAMES.some((n) => key.endsWith(n))) return false;
    held = true;
    return true;
  };
}

/** The upload folders that exist in collection A's storage right now. */
function uploadFolders(app: App): string[] {
  const seen = new Set<string>();
  for (const key of app.s3.objects.keys()) {
    const prefix = `${BUCKET_A}/${UPLOADS_PREFIX}`;
    if (!key.startsWith(prefix)) continue;
    seen.add(key.slice(prefix.length).split('/')[0]);
  }
  return [...seen];
}

/** A partial run, remembering which upload folder it claimed. */
async function producePartialRun(app: App, specs: FileSpec[] = publishableBatch()): Promise<void> {
  await basePartialRun(app, specs);
  app.notes.uploadFolder = uploadFolders(app).find((f) => !f.startsWith('2026.01.02'))!;
}

/** Click Resume in History; the folder dialog hands back the source folder. */
async function resumeFromHistory(app: App): Promise<void> {
  await app.gotoSection('History');
  await app.page.getByRole('button', { name: 'Resume' }).first().click();
}

// --- recording -------------------------------------------------------------

When('a real upload starts', async ({ app }) => {
  // See CORRECTIONS.md "The session ledger can clobber per-file state it
  // just recorded" — openSession's un-awaited bulk write can overwrite a
  // file's just-landed done/failed state with pending. Give storage a beat
  // so the ledger settles first, matching every other real-run helper.
  app.s3.putDelayMs = 150;
  await app.dropFolder(publishableBatch());
  await app.walkToUploadStep({ uploader: 'Ada Lovelace', description: 'July retrieval' });
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then(
  'the destination, deployment, uploader, description, timezone and the state of every file are recorded on this machine',
  async ({ app }) => {
    const [batch] = await app.readBatchRecords();
    expect(batch).toBeTruthy();
    expect(batch.targetBucket).toBe(BUCKET_A);
    expect(batch.uploadPrefix).toMatch(new RegExp(`^${UPLOADS_PREFIX}`));
    expect(batch.deploymentId).toBe(`${UUID_A}:BEAR1`);
    expect(batch.uploaderUser).toBe('Ada Lovelace');
    expect(batch.uploaderSlug).toBe('ada-lovelace');
    expect(batch.description).toBe('July retrieval');
    expect(batch.uploadTimeZone).toBe('America/Phoenix');
    expect(batch.totalFiles).toBe(4);
    expect(await app.readFileRecords()).toHaveLength(4);
  },
);

Then("each file's state is updated as it lands", async ({ app }) => {
  const files = await app.readFileRecords();
  expect(files.every((f) => f.state === 'done')).toBe(true);
  for (const f of files) {
    expect(f.remoteKey).toMatch(new RegExp(`^${UPLOADS_PREFIX}`));
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

When('a dry run is started', async ({ app }) => {
  await app.dropFolder(publishableBatch());
  await app.walkToUploadStep({ uploader: 'Ada Lovelace' });
  await app.dryRunCheckbox().check();
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then('nothing about it appears in History', async ({ app }) => {
  expect(await app.readBatchRecords()).toHaveLength(0);
  expect(await app.readFileRecords()).toHaveLength(0);
  await app.gotoSection('History');
  await expect(app.page.getByText('No uploads yet')).toBeVisible();
});

// --- open vs complete ------------------------------------------------------

Given('an upload was interrupted before its metadata was published', async ({ app }) => {
  await producePartialRun(app);
});

When('History is opened', async ({ app }) => {
  await app.gotoSection('History');
});

Then('that upload is listed as open', async ({ app }) => {
  await expect(app.page.getByText('open', { exact: true })).toBeVisible();
  await expect(app.page.getByText('complete', { exact: true })).toHaveCount(0);
});

Then('it shows how many of its files are done and how many failed', async ({ app }) => {
  await expect(app.page.getByText(/4 files · .* · 3 done · 1 failed/)).toBeVisible();
});

Then('only uploads whose metadata was published are marked complete', async ({ app }) => {
  // A second, unobstructed run of the same folder does publish, and it is the
  // one that shows as complete. Upload paths are stamped to the second, so
  // give this run a fresh stamp: started inside the same second as the
  // partial run, both would target one folder and the second run's
  // immutable writes would be refused as "Object already exists".
  app.s3.putHooks.length = 0;
  app.s3.putDelayMs = 0;
  await app.page.waitForTimeout(1_100);
  await app.gotoSection('New upload');
  await app.page.getByRole('button', { name: 'Back' }).click();
  await app.page.getByRole('button', { name: 'Back' }).click();
  await app.rescan(app.notes.sourceSpecs as FileSpec[]);
  await app.page.getByRole('button', { name: 'Continue' }).click();
  await app.continueToUpload();
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
  await app.gotoSection('History');
  await expect(app.page.getByText('complete', { exact: true })).toHaveCount(1);
  await expect(app.page.getByText('open', { exact: true })).toHaveCount(1);
});

// --- resuming --------------------------------------------------------------

Given('an open upload is listed in History', async ({ app }) => {
  await producePartialRun(app);
  await app.gotoSection('History');
  await expect(app.page.getByRole('button', { name: 'Resume' })).toBeVisible();
});

When('it is resumed', async ({ app }) => {
  app.s3.putHooks.length = 0;
  app.notes.putsBeforeResume = app.s3.puts.length;
  await resumeFromHistory(app);
});

Then(
  'the source folder is re-attached, by permission for a remembered folder or by selecting it again',
  async ({ app }) => {
    // No durable handle was ever granted, so the reselect path is the one taken.
    const [batch] = await app.readBatchRecords();
    expect(batch.fileAccessMode).toBe('reselect-required');
    // History reattaches, then hands the prepared session to the wizard's
    // Upload step, which is where the run itself becomes visible.
    await app.expectStep('Upload');
    await expect.poll(() => app.logText(), { timeout: 60_000 }).toContain('resuming ');
  },
);

Then('the upload continues from where it stopped', async ({ app }) => {
  await expect(app.page.getByText(/Published \d+ files under/)).toBeVisible({ timeout: 120_000 });
  const after = app.s3.puts.slice(app.notes.putsBeforeResume as number);
  expect(after.filter((p) => p.key.endsWith(FAILING_FILE))).toHaveLength(1);
  expect(after.filter((p) => METADATA_NAMES.some((n) => p.key.endsWith(n)))).toHaveLength(5);
});

Given('a resumed upload has files recorded as already stored', async ({ app }) => {
  await producePartialRun(app);
  app.s3.putHooks.length = 0;
  // One of the already-stored objects has vanished from storage.
  const missing = [...app.s3.objects.keys()].find((k) => k.endsWith('IMG_0003.JPG'))!;
  app.notes.missingKey = missing;
  app.s3.objects.delete(missing);
  app.notes.headsBefore = app.s3.heads.length;
  await resumeFromHistory(app);
  await expect(app.page.getByText(/Published \d+ files under/)).toBeVisible({ timeout: 120_000 });
});

Then('each of those objects is re-checked for its size and recorded fingerprint', async ({ app }) => {
  const heads = app.s3.heads.slice(app.notes.headsBefore as number);
  expect(heads.some((h) => h.endsWith('IMG_0001.JPG'))).toBe(true);
  expect(heads.some((h) => h.endsWith('IMG_0003.JPG'))).toBe(true);
});

Then('matching objects are skipped rather than uploaded again', async ({ app }) => {
  const log = await app.logText();
  expect(log).toMatch(/verified, skip: [^\s]*IMG_0001\.JPG/);
});

Then('an object that is missing or does not match is uploaded again', async ({ app }) => {
  const log = await app.logText();
  expect(log).toMatch(/remote missing, re-uploading: [^\s]*IMG_0003\.JPG/);
  const [bucket, ...rest] = (app.notes.missingKey as string).split('/');
  expect(app.s3.has(bucket, rest.join('/'))).toBe(true);
});

When('an interrupted upload is resumed', async ({ app }) => {
  await producePartialRun(app);
  app.s3.putHooks.length = 0;
  await resumeFromHistory(app);
  await expect(app.page.getByText(/Published \d+ files under/)).toBeVisible({ timeout: 120_000 });
});

Then(
  'it writes to the same collection, the same upload folder and the same object paths as the original attempt',
  async ({ app }) => {
    expect(uploadFolders(app).filter((f) => !f.startsWith('2026.01.02'))).toEqual([
      app.notes.uploadFolder,
    ]);
    for (const put of app.s3.puts) {
      expect(put.bucket).toBe(BUCKET_A);
      if (put.key.startsWith(UPLOADS_PREFIX)) {
        expect(put.key.startsWith(`${UPLOADS_PREFIX}${app.notes.uploadFolder}/`) || put.key.includes('2026.01.02')).toBe(true);
      }
    }
  },
);

Then(
  'the deployment, uploader identity and description are taken from the recorded session, not re-entered',
  async ({ app }) => {
    const meta = JSON.parse(metadataPuts(app).find((p) => p.key.endsWith('UploadMeta.json'))!.body);
    expect(meta.uploadUser).toBe('ada-lovelace');
    expect(meta.description).toBe('July retrieval');
    const deployments = metadataPuts(app).find((p) => p.key.endsWith('deployments.csv'))!;
    expect(deployments.body).toContain(`${UUID_A}:BEAR1`);
    // Nothing on the History screen asked for any of it.
    await expect(app.page.getByRole('heading', { name: 'Target collection' })).toHaveCount(0);
  },
);

Then(
  "the resumed upload's observations.csv matches what a fresh upload would have written",
  async ({ app }) => {
    const rows = writtenCsvRows(app, 'observations.csv');
    expect(rows.length).toBeGreaterThan(0);
    // Every row is a blank placeholder (no species identified).
    for (const row of rows) {
      expect(row[5]).toBe('blank');   // observationType
      expect(row[9]).toBe('');        // count — blank, not "0"
      expect(row[10]).toBe('');       // count_new — blank, not "0"
    }
  },
);

// --- retrying from the Upload step -----------------------------------------

Given('a real upload finished as partial with some files failed', async ({ app }) => {
  await producePartialRun(app);
  app.notes.storedBeforeRetry = app.s3.writtenKeys();
});

When('"Retry failed files" is chosen', async ({ app }) => {
  app.s3.putHooks.length = 0;
  await app.page.getByRole('button', { name: 'Retry failed files' }).click();
});

Then('only the failed and not-yet-sent files are uploaded', async ({ app }) => {
  await app.waitForRunPhase('done', 120_000);
  const before = app.notes.storedBeforeRetry as string[];
  const retried = mediaPuts(app)
    .map((p) => `${p.bucket}/${p.key}`)
    .filter((k) => !before.includes(k));
  expect(retried).toHaveLength(1);
  expect(retried[0]).toContain(FAILING_FILE);
});

Then('the successfully stored files are left alone', async ({ app }) => {
  const log = await app.logText();
  for (const name of ['IMG_0001.JPG', 'IMG_0003.JPG']) {
    expect(log).toMatch(new RegExp(`verified, skip: [^\\s]*${name}`));
  }
});

Then('when they all land, the metadata for that same upload folder is published', async ({ app }) => {
  const written = metadataPuts(app);
  expect(written.map((p) => p.key.split('/').pop())).toEqual(METADATA_NAMES);
  for (const put of written) {
    expect(put.key).toBe(`${UPLOADS_PREFIX}${app.notes.uploadFolder}/${put.key.split('/').pop()}`);
  }
});

Then('exactly one upload exists in the destination', async ({ app }) => {
  expect(uploadFolders(app).filter((f) => !f.startsWith('2026.01.02'))).toHaveLength(1);
});

When('a failed upload is retried or resumed', async ({ app }) => {
  await producePartialRun(app);
  app.s3.putHooks.length = 0;
  await app.page.getByRole('button', { name: 'Retry failed files' }).click();
  await app.waitForRunPhase('done', 120_000);
});

Then(
  'the collection, deployment, uploader identity and timezone are not asked for again',
  async ({ app }) => {
    await expect(app.page.getByRole('heading', { name: 'Target collection' })).toHaveCount(0);
    await expect(app.page.getByRole('heading', { name: 'Deployment' })).toHaveCount(0);
    const [batch] = await app.readBatchRecords();
    expect(batch.uploadTimeZone).toBe('America/Phoenix');
    const meta = JSON.parse(metadataPuts(app).find((p) => p.key.endsWith('UploadMeta.json'))!.body);
    expect(meta.uploadUser).toBe('ada-lovelace');
  },
);

// --- reconciling the source ------------------------------------------------

When('an upload is resumed', async ({ app }) => {
  await producePartialRun(app);
  app.s3.putHooks.length = 0;
  // Same path and size, but one already-stored file's bytes have changed.
  await app.editPickedFolder(
    `${FOLDER}/IMG_0003.JPG`,
    // Same length as the original salt, so only the bytes differ, not the size.
    jpegAt('IMG_0003.JPG', '2026:07:01 12:10:00', 'ZZZZZZZZZZZZ').bytes!,
  );
  app.notes.headsBefore = app.s3.heads.length;
  await resumeFromHistory(app);
});

Then(
  'each recorded file is matched against the selected folder by its relative path, its size and its content fingerprint',
  async ({ app }) => {
    await expect(app.page.getByText(/could not be reconciled/)).toBeVisible({ timeout: 60_000 });
    const records = await app.readFileRecords();
    expect(records.map((r) => r.localPath).sort()).toEqual(
      (app.notes.sourceSpecs as FileSpec[]).map((s) => s.path).sort(),
    );
  },
);

Then('a file whose content has changed since the original attempt is not uploaded', async ({ app }) => {
  await expect(app.page.getByText(/Published \d+ files under/)).toBeVisible({ timeout: 120_000 });
  const log = await app.logText();
  // It was already stored, so it is verified and skipped, never re-sent.
  expect(log).toMatch(/verified, skip: [^\s]*IMG_0003\.JPG/);
});

Then('such files are listed with the reason they could not be matched', async ({ app }) => {
  await expect(app.page.getByText('IMG_0003.JPG — content hash differs from the original')).toBeVisible();
});

Given(
  'some files that are not yet stored cannot be matched in the selected folder',
  async ({ app }) => {
    await producePartialRun(app);
    app.s3.putHooks.length = 0;
    await app.editPickedFolder(`${FOLDER}/${FAILING_FILE}`, null);
    await resumeFromHistory(app);
  },
);

Then('the resume does not start', async ({ app }) => {
  await expect(app.page.getByText(/could not be reattached/)).toBeVisible({ timeout: 60_000 });
  await expect(app.page.getByText(/^Resuming \d/)).toHaveCount(0);
});

Then(
  'the tool states how many files could not be re-attached and asks for the original folder',
  async ({ app }) => {
    await expect(
      app.page.getByText(
        /1 pending or failed source file could not be reattached\. Reselect the original folder before resuming\./,
      ),
    ).toBeVisible();
    await expect(app.page.getByText(`${FOLDER}/${FAILING_FILE} — not in the selected folder`)).toHaveCount(0);
    await expect(app.page.getByText(/not in the selected folder/)).toBeVisible();
  },
);

// --- interrupted before examination finished -------------------------------

Given('an upload was interrupted before every file had been examined', async ({ app }) => {
  app.notes.sourceSpecs = slowPublishableBatch();
  await app.dropFolder(app.notes.sourceSpecs as FileSpec[]);
  await app.walkToUploadStep({ uploader: 'Ada Lovelace', description: 'July retrieval' });
  holdFirstMediaPut(app);
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect.poll(() => app.s3.puts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await app.page.getByRole('button', { name: 'Cancel' }).click();
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
});

Then('no publishable metadata exists for it', async ({ app }) => {
  expect(await app.readBundleRecords()).toHaveLength(0);
  expect(app.s3.puts.some((p) => METADATA_NAMES.some((n) => p.key.endsWith(n)))).toBe(false);
});

Then('the remaining files are examined again and the upload completes', async ({ app }) => {
  // No publish-ready bundle existed yet (Then('no publishable metadata
  // exists for it')), so resuming re-examines whatever never finished
  // Inspect and builds the bundle this session never got, then publishes to
  // the same destination the original run was headed for.
  await expect(app.page.getByText(/Published \d+ files under/)).toBeVisible({ timeout: 120_000 });
});

Then('no data is lost', async ({ app }) => {
  // Everything that landed before the interruption is still in the collection.
  expect(app.s3.puts.length).toBeGreaterThan(0);
  for (const put of app.s3.puts) expect(app.s3.has(put.bucket, put.key)).toBe(true);
  expect(await app.readBatchRecords()).toHaveLength(1);
});

// --- discarding ------------------------------------------------------------

When('an upload is discarded from History', async ({ app }) => {
  await producePartialRun(app);
  app.notes.storedKeys = app.s3.writtenKeys();
  await app.gotoSection('History');
  await app.page.getByRole('button', { name: 'Discard' }).first().click();
});

Then('its local record and file states are removed from this machine', async ({ app }) => {
  await expect(app.page.getByText('No uploads yet')).toBeVisible();
  expect(await app.readBatchRecords()).toHaveLength(0);
  expect(await app.readFileRecords()).toHaveLength(0);
});

Then('nothing stored in the collection is touched', async ({ app }) => {
  for (const key of app.notes.storedKeys as string[]) {
    const [bucket, ...rest] = key.split('/');
    expect(app.s3.has(bucket, rest.join('/'))).toBe(true);
  }
});

// --- watching a resume -----------------------------------------------------

Given('a resume is running', async ({ app }) => {
  await producePartialRun(app);
  app.s3.putHooks.length = 0;
  holdFirstMediaPut(app);
  await resumeFromHistory(app);
  // History prepares the resume and hands it to the wizard's Upload step, which
  // owns the run UI — so that is where a resume in flight is watched.
  await app.expectStep('Upload');
  await expect(app.runPhase()).toHaveText('uploading', { timeout: 60_000 });
});

Then(
  'the same per-file progress, byte totals and activity log are shown as for a fresh upload',
  async ({ app }) => {
    await expect(app.page.getByText(/[\d.]+ (B|KB|MB|GB) \/ [\d.]+ (B|KB|MB|GB)/)).toBeVisible();
    await expect(app.page.locator('div[data-index]').first()).toBeVisible();
    await expect.poll(() => app.logText(), { timeout: 60_000 }).toContain('resuming ');
  },
);

Then('the resume can be cancelled', async ({ app }) => {
  // The Upload step's own Cancel, the same control a fresh run offers.
  const cancel = app.page.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
});

Then('no other upload can be resumed while one is running', async ({ app }) => {
  // The store's `activeRunSessionId` is what disables every Resume and the
  // running session's Discard while a run is in flight, so History is where it
  // shows. Checking it must leave the run alone — the user is looking, not
  // abandoning.
  await app.gotoSection('History');
  await expect(app.page.getByRole('button', { name: 'Resume' }).first()).toBeDisabled();
  await app.gotoSection('New upload');
  await expect(app.runPhase()).toHaveText('uploading');
});

When('the user leaves History and returns while the resume is running', async ({ app }) => {
  await app.gotoSection('Settings');
  await expect(app.page.getByText('Uploader identity')).toBeVisible();
  await app.gotoSection('History');
});

Then('the resumed session cannot be resumed or discarded', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Resume' }).first()).toBeDisabled();
  await expect(app.page.getByRole('button', { name: 'Discard' }).first()).toBeDisabled();
  expect(await app.readBatchRecords()).toHaveLength(1);
});

Then('the resume remains visible and cancellable on the Upload step', async ({ app }) => {
  await app.gotoSection('New upload');
  await expect(app.runPhase()).toHaveText('uploading');
  await expect(app.page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await app.page.getByRole('button', { name: 'Cancel' }).click();
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
});

Given('a fresh upload is running in the background', async ({ app }) => {
  await app.dropFolder(publishableBatch());
  await app.walkToUploadStep({ uploader: 'Ada Lovelace', description: 'July retrieval' });
  holdFirstMediaPut(app);
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect.poll(() => app.s3.puts.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

When('History is opened during the fresh upload', async ({ app }) => {
  await app.gotoSection('History');
  await expect(app.page.getByRole('button', { name: 'Resume' })).toBeVisible();
});

Then('its live local session cannot be resumed or discarded', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Resume' })).toBeDisabled();
  await expect(app.page.getByRole('button', { name: 'Discard' }).first()).toBeDisabled();
  expect(await app.readBatchRecords()).toHaveLength(1);
  await app.gotoSection('New upload');
  await app.page.getByRole('button', { name: 'Cancel' }).click();
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
});

// --- a retry with no readable record ---------------------------------------

Given('the local record for a partial run cannot be read', async ({ app }) => {
  await producePartialRun(app);
  await app.page.evaluate(async () => {
    const open = indexedDB.open('sparcd-uploader');
    const db: IDBDatabase = await new Promise((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise((resolve) => {
      const req = db.transaction('batches', 'readwrite').objectStore('batches').clear();
      req.onsuccess = () => resolve(null);
    });
  });
});

Then('the tool reports that the saved record could not be loaded', async ({ app }) => {
  // retryFailed's catch is now a single generic wrapper covering every
  // failure mode in its try block (not just a missing session record, since
  // ensureBundle can fail here too) — the underlying reason still comes
  // through via the error message it wraps.
  await expect(
    app.page.getByText(/Couldn't resume this upload \(no saved record for this session\)/),
  ).toBeVisible({ timeout: 60_000 });
});

Then('it suggests retrying, or going back and starting the upload over', async ({ app }) => {
  await expect(
    app.page.getByText(/Retry again; if it keeps failing, go Back and start the upload over\./),
  ).toBeVisible();
});

Then('repeated clicks never start two runs at once', async ({ app }) => {
  const retry = app.page.getByRole('button', { name: 'Retry failed files' });
  await retry.click();
  await retry.click();
  await retry.click();
  await expect(app.runPhase()).toHaveText('partial');
  await expect(app.page.getByText(/Couldn't resume this upload/)).toHaveCount(1);
});

// --- picker cancel fallback (issue #68) ------------------------------------

When('the folder picker is opened and dismissed without selecting a folder', async ({ app }) => {
  await app.gotoSection('History');
  await app.dismissFallbackPickerWithoutCancel();
  // Click Resume — takes the <input webkitdirectory> fallback path because
  // showDirectoryPicker was removed by the preceding step. The test shim
  // restores focus from inside input.click(), before the click handler returns,
  // matching the production ordering that previously lost this event.
  await app.page.getByRole('button', { name: 'Resume' }).first().click();
});

Then('the Resume button becomes available again', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Resume' }).first()).toBeEnabled();
});
