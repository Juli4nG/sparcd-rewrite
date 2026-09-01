import { Given, When, Then, expect } from './fixtures';
import type { App } from './app';
import { FOLDER, manyJpegs, publishableBatch, sameNameSubfolderBatch, slowPublishableBatch, standardBatch } from './batches';
import { rescanFromUpload, writtenCsvRows } from './helpers';
import { BUCKET_A, COLLECTION_A_NAME, UUID_A } from './fixtures-data';

const UPLOADS_PREFIX = `Collections/${UUID_A}/Uploads/`;
const METADATA_NAMES = [
  'deployments.csv',
  'media.csv',
  'observations.csv',
  'UploadMeta.json',
  'UploadComplete.json',
];

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

Given(
  'a batch has a collection, a deployment, an uploader identity and capture times',
  async ({ app }) => {
    await app.connect();
    await app.dropFolder(publishableBatch());
    await expect(app.fileListPane()).toBeVisible();
  },
);

Given('the New upload section is showing the Upload step', async ({ app }) => {
  await app.walkToUploadStep({ uploader: 'Ada Lovelace', description: 'July retrieval' });
});

// --- dry run ---------------------------------------------------------------

Given('the upload has not been started', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: /^Start (dry run|upload)$/ })).toBeVisible();
  expect(app.s3.puts).toHaveLength(0);
});

Then(
  'the ready status explains itself on hover and keyboard focus',
  async ({ app }) => {
    const pill = app.page.getByRole('status');
    const tooltip = app.page.locator('[role="tooltip"]');
    await expect(pill).toContainText('ready');
    await expect(pill).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id'));
    await pill.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(
      'Ready to start an upload; no upload is currently in progress',
    );
    await app.page.mouse.move(0, 0);
    await pill.focus();
    await expect(tooltip).toBeVisible();
  },
);

Then(
  'the complete status explains itself on hover and keyboard focus',
  async ({ app }) => {
    const pill = app.page.getByRole('status');
    const tooltip = app.page.locator('[role="tooltip"]');
    await expect(pill).toContainText('complete');
    await pill.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText('Upload complete');
    await app.page.mouse.move(0, 0);
    await pill.focus();
    await expect(tooltip).toBeVisible();
  },
);

Then('the completion dialog states the file count and collection ID', async ({ app }) => {
  const dialog = app.page.getByRole('dialog', { name: 'Upload complete' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Published 4 files to ${UUID_A}`);
});

Then('dismissing it closes the dialog', async ({ app }) => {
  await app.page.getByRole('button', { name: 'OK' }).click();
  await expect(app.page.getByRole('dialog', { name: 'Upload complete' })).toHaveCount(0);
});

async function expectDryRunPill(app: App): Promise<void> {
  const pill = app.page.getByRole('status');
  const tooltip = app.page.locator('[role="tooltip"]');
  await expect(pill).toContainText('dry-run');
  await pill.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Dry run — nothing is written to S3');
  await app.page.mouse.move(0, 0);
  await pill.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Dry run — nothing is written to S3');
}

Then('dry run is switched off by default', async ({ app }) => {
  await expect(app.dryRunCheckbox()).not.toBeChecked();
  await expect(app.page.getByRole('button', { name: 'Start upload' })).toBeVisible();
});

When('the operator opts into a dry run', async ({ app }) => {
  await app.dryRunCheckbox().check();
});

When('the dry run is started', async ({ app }) => {
  await app.startRun();
});

Then(
  'the title-bar pill and tooltip show dry-run while blobs are processing and after completion',
  async ({ app }) => {
    // The held inspection result keeps the streaming queue open, so
    // "uploading" deterministically means the dry run is in its blobs phase.
    await app.waitForRunPhase('uploading');
    await expectDryRunPill(app);
    await app.releaseHeldInspect();
    await app.waitForRunPhase('done');
    await expectDryRunPill(app);
  },
);

Then(
  'starting it lists every object that would be written, with its size and fingerprint',
  async ({ app }) => {
    await app.startRun();
    await app.waitForRunPhase('done');
    const log = await app.logText();
    for (const name of ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0003.JPG', 'BIG_CLIP.MP4']) {
      expect(log).toMatch(new RegExp(`PUT ${BUCKET_A}/${UPLOADS_PREFIX}[^\\s]*${name} \\(\\d+ B, sha256 [0-9a-f]{12}…\\)`));
    }
    for (const name of METADATA_NAMES) expect(log).toContain(`/${name} (`);
  },
);

Then('nothing is written to storage', async ({ app }) => {
  expect(app.s3.puts).toHaveLength(0);
  expect(app.s3.multipart.size).toBe(0);
});

Then('the run is not recorded in History', async ({ app }) => {
  expect(await app.readBatchRecords()).toHaveLength(0);
  await app.gotoSection('History');
  await expect(app.page.getByText('No uploads yet')).toBeVisible();
});

Then(
  "the tool states that a setup issue on the storage side is not the user's fault",
  async ({ app }) => {
    await expect(app.page.getByText(/that's usually a setup issue on the storage side/)).toContainText(
      "not something you did wrong",
    );
  },
);

Then('that the collection ID is given to contact an administrator with', async ({ app }) => {
  await expect(app.page.getByText(/that's usually a setup issue on the storage side/)).toContainText(
    `this collection ID: ${UUID_A}`,
  );
});

// --- a complete real upload ------------------------------------------------

When('a real upload is started and completes', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

When('a real upload completes without dismissing its confirmation', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect(app.runPhase()).toHaveText('done', { timeout: 60_000 });
});

Then(
  'every media file of the batch is stored under a single upload folder in the chosen collection',
  async ({ app }) => {
    const keys = mediaPuts(app).map((p) => p.key);
    expect(keys).toHaveLength(4);
    const folders = new Set(keys.map((k) => k.slice(0, k.indexOf('/', UPLOADS_PREFIX.length) + 1)));
    expect(folders.size).toBe(1);
    expect([...folders][0]).toMatch(new RegExp(`^${UPLOADS_PREFIX}`));
    for (const p of app.s3.puts) expect(p.bucket).toBe(BUCKET_A);
  },
);

Then("the folder is named for the moment of upload and the uploader's identity", async ({ app }) => {
  const key = mediaPuts(app)[0].key;
  const folder = key.slice(UPLOADS_PREFIX.length).split('/')[0];
  expect(folder).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.\d{2}_ada-lovelace$/);
});

Then("each stored object's path is the one recorded for it in the media table", async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  const recorded = rows.map((r) => r[5]).sort();
  const stored = mediaPuts(app).map((p) => p.key).sort();
  expect(recorded).toEqual(stored);
  for (const row of rows) expect(row[0]).toBe(row[5]); // media_id == file_path
});

// --- verification ----------------------------------------------------------

When('a file has been uploaded', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then(
  'the tool lists the upload folder and confirms every object is stored at its recorded size',
  async ({ app }) => {
    const puts = mediaPuts(app);
    // `Collections/<uuid>/Uploads/<stamp>_<user>/` — the whole batch in one pass,
    // not the per-file subfolders underneath it.
    const folder = puts[0].key.split('/').slice(0, 4).join('/');
    expect(app.s3.lists).toContain(`${puts[0].bucket}/${folder}/`);
    await expect(
      app.page.getByText(new RegExp(`final review: all ${puts.length} objects confirmed`)),
    ).toBeVisible();
  },
);

Then(
  'a few of the stored objects are re-read to confirm storage kept their recorded fingerprint',
  async ({ app }) => {
    const puts = mediaPuts(app);
    // The listing carries the size but not the fingerprint, so a sample is
    // re-read for it — a sample, not every object.
    const reread = puts.filter((p) => app.s3.heads.includes(`${p.bucket}/${p.key}`));
    expect(reread.length).toBeGreaterThan(0);
    expect(reread.length).toBeLessThan(puts.length);
  },
);

Then(
  'an object the listing contradicts is treated as a failure of that file, not as a success',
  async ({ app }) => {
    // Re-run against storage that accepts a write and then quietly truncates
    // it, so the listing reports a size the metadata does not claim.
    app.s3.afterPut = (_bucket, key, obj) => {
      if (key.endsWith('IMG_0002.JPG')) obj.body = obj.body.subarray(0, 1);
    };
    const metadataBefore = app.s3.puts.filter((p) => METADATA_NAMES.some((n) => p.key.endsWith(n))).length;
    await rescanFromUpload(app, standardBatch());
    await app.dryRunCheckbox().uncheck();
    await app.startRun();
    await expect(app.page.getByText(/final review: size mismatch/).first()).toBeVisible({ timeout: 60_000 });
    const rows = await app.page.locator('div[data-index]').allTextContents();
    const mismatched = rows.find((r) => r.includes('IMG_0002.JPG'))!;
    expect(mismatched).not.toContain('done');
    expect(
      app.s3.puts.filter((p) => METADATA_NAMES.some((n) => p.key.endsWith(n))).length,
    ).toBe(metadataBefore);
  },
);

Then(
  "an object whose sha256 fingerprint is absent from storage is treated as a failure",
  async ({ app }) => {
    // Strip sha256 from every non-metadata PUT after storage — simulates a path
    // that accepts the upload but loses or never returns the digest header.
    app.s3.afterPut = (_bucket, key, obj) => {
      if (!METADATA_NAMES.some((n) => key.endsWith(n))) delete obj.meta['sha256'];
    };
    const metadataBefore = app.s3.puts.filter((p) => METADATA_NAMES.some((n) => p.key.endsWith(n))).length;
    await rescanFromUpload(app, standardBatch());
    await app.dryRunCheckbox().uncheck();
    await app.startRun();
    await expect(app.page.getByText(/final review: digest contract broken/).first()).toBeVisible({ timeout: 60_000 });
    await expect(app.runPhase()).toHaveText('partial');
    expect(
      app.s3.puts.filter((p) => METADATA_NAMES.some((n) => p.key.endsWith(n))).length,
    ).toBe(metadataBefore);
  },
);

// --- streaming past Inspect ------------------------------------------------

Given('some files are still being examined', async ({ app }) => {
  await app.holdInspect('BIG_CLIP.MP4');
  await app.rescanFromUploadStep();
  await expect(app.page.getByText(/still being inspected/)).toBeVisible();
});

When('the upload is started', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  app.notes.putsAtStart = app.s3.puts.length;
  await app.startRun();
});

Then('files that have already been examined start uploading immediately', async ({ app }) => {
  await expect.poll(() => mediaPuts(app).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  expect(app.s3.puts.every((p) => !p.key.endsWith('BIG_CLIP.MP4'))).toBe(true);
  await app.releaseHeldInspect();
});

Then("each remaining file starts as soon as its own examination finishes", async ({ app }) => {
  await expect.poll(() => mediaPuts(app).length, { timeout: 60_000 }).toBe(4);
  expect(mediaPuts(app).some((p) => p.key.endsWith('BIG_CLIP.MP4'))).toBe(true);
});

Then('the tool reports how many files are still being examined', async ({ app }) => {
  await app.waitForRunPhase('done');
  // The note is gone once every file has been examined.
  await expect(app.page.getByText(/still being inspected/)).toHaveCount(0);
});

// --- streaming survives navigation -----------------------------------------

Given('a streaming run has started with one file still being examined', async ({ app }) => {
  await app.holdInspect('BIG_CLIP.MP4');
  await app.rescanFromUploadStep();
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
});

When('the user navigates to the History section', async ({ app }) => {
  await app.gotoSection('History');
});

When('the held file finishes being examined', async ({ app }) => {
  await app.releaseHeldInspect();
  // Stay on History until the held result has crossed the module-level bridge
  // and uploaded. Returning sooner could remount Upload before onFilesReady
  // fires, allowing the old component-scoped bridge to pass this scenario.
  await expect(
    app.page.locator('nav[aria-label="Sections"]').getByRole('button', { name: 'History' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => app.s3.puts.some((p) => p.key.endsWith('BIG_CLIP.MP4'))).toBe(true);
});

When('the user returns to the New upload section', async ({ app }) => {
  await app.gotoSection('New upload');
});

Then('the run completes successfully', async ({ app }) => {
  await app.waitForRunPhase('done');
});

// --- publish ordering ------------------------------------------------------

Given('a real upload is running', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
});

Then(
  'the metadata files are written only after every file in the batch has been stored and verified',
  async ({ app }) => {
    await app.waitForRunPhase('done');
    const keys = app.s3.puts.map((p) => p.key);
    const firstMetadata = keys.findIndex((k) => METADATA_NAMES.some((n) => k.endsWith(n)));
    expect(firstMetadata).toBe(4); // the four media objects come first
    // …and the listing that confirms them runs before any metadata is written.
    await expect(app.page.getByText(/final review: all 4 objects confirmed/)).toBeVisible();
  },
);

Then(
  'they are written in a fixed order, with the upload metadata file last but one and the completion record last',
  async ({ app }) => {
    const tail = app.s3.puts.slice(4).map((p) => p.key.split('/').pop());
    expect(tail).toEqual(METADATA_NAMES);
  },
);

// --- partial runs ----------------------------------------------------------

Given('a real upload in which some files failed after their retries', async ({ app }) => {
  app.s3.putHooks.push((_b, key) =>
    key.endsWith('IMG_0002.JPG') ? { status: 400, code: 'InvalidRequest', message: 'refused' } : undefined,
  );
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('partial', 120_000);
});

Then('no metadata files are written', async ({ app }) => {
  expect(app.s3.puts.some((p) => METADATA_NAMES.some((n) => p.key.endsWith(n)))).toBe(false);
});

Then('the run is reported as partial, stating how many files failed', async ({ app }) => {
  await expect(app.runPhase()).toHaveText('partial');
  await expect(app.page.getByText(/1 of 4 files failed to upload/)).toBeVisible();
});

Then(
  'the tool states that the upload is not yet visible and can be completed by retrying the failed files',
  async ({ app }) => {
    await expect(
      app.page.getByText(/Metadata was not published, so this upload is not yet visible; retry the failed files to complete it\./),
    ).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Retry failed files' })).toBeVisible();
  },
);

// --- abandoned runs --------------------------------------------------------

Given('a real upload that was cancelled or ended in failure', async ({ app }) => {
  holdFirstMediaPut(app);
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect.poll(() => app.s3.puts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await app.page.getByRole('button', { name: 'Cancel' }).click();
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
});

Then('no upload metadata file was written for it', async ({ app }) => {
  expect(app.s3.puts.some((p) => p.key.endsWith('UploadMeta.json'))).toBe(false);
});

Then('nothing reading the collection sees a new upload there', async ({ app }) => {
  await app.gotoSection('History');
  await app.publishedCollectionSelect().selectOption({ label: COLLECTION_A_NAME });
  const cards = app.page.locator('ul li').filter({ hasText: 'Edit description' });
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('priorperson');
});

// --- untagged batches ------------------------------------------------------

When('a batch is published', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then('a placeholder observations table is written alongside the media table', async ({ app }) => {
  const obsRows = writtenCsvRows(app, 'observations.csv');
  expect(obsRows).toHaveLength(4);
  for (const row of obsRows) expect(row[5]).toBe('blank'); // observationType col
  expect(writtenCsvRows(app, 'media.csv')).toHaveLength(4);
});

Then('the upload metadata records that none of its images carry a species', async ({ app }) => {
  const meta = JSON.parse(app.s3.puts.find((p) => p.key.endsWith('UploadMeta.json'))!.body);
  expect(meta.imagesWithSpecies).toBe(0);
  expect(meta.imageCount).toBe(4);
});

Then(
  "each blank row's observation ID is the path-relative filename followed by \":0\"",
  async ({ app }) => {
    const obsRows = writtenCsvRows(app, 'observations.csv');
    for (const row of obsRows) expect(row[0]).toMatch(/.+:0$/);
  },
);

Given(
  'a batch contains two files with the same filename under different subfolders',
  async ({ app }) => {
    await rescanFromUpload(app, sameNameSubfolderBatch());
  },
);

Then(
  "each file's blank row carries a distinct path-scoped observation ID",
  async ({ app }) => {
    const obsRows = writtenCsvRows(app, 'observations.csv');
    expect(obsRows).toHaveLength(2);
    const ids = obsRows.map((r) => r[0]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/:0$/);
    expect(ids).toContain(`${FOLDER}/cam1/IMG_0001.JPG:0`);
    expect(ids).toContain(`${FOLDER}/cam2/IMG_0001.JPG:0`);
  },
);

// --- progress reporting ----------------------------------------------------

Given('a run is in progress', async ({ app }) => {
  app.s3.putDelayMs = 1000;
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect(app.runPhase()).toHaveText('uploading');
});

Then('each file shows its own state and percentage', async ({ app }) => {
  const states = await app.page.locator('div[data-index] span.text-right').allTextContents();
  expect(states.length).toBeGreaterThan(0);
  expect(states.some((s) => /^\d+%$/.test(s) || ['pending', 'done', 'inspecting'].includes(s))).toBe(true);
});

Then(
  'the batch shows bytes uploaded against the total, and counts of done, skipped and failed files',
  async ({ app }) => {
    await expect(app.page.getByText(/[\d.]+ (B|KB|MB|GB) \/ [\d.]+ (B|KB|MB|GB)/)).toBeVisible();
    await expect(app.page.getByText(/\d+ done/)).toBeVisible();
  },
);

Then(
  'an activity log records each retry, each warning and each metadata write as it happens',
  async ({ app }) => {
    await app.waitForRunPhase('done', 120_000);
    const log = await app.logText();
    for (const name of METADATA_NAMES) expect(log).toContain(`/${name}`);
    expect(log).toContain('wrote ');
    // A successful blob write is deliberately not logged in a wet run.
    expect(log).not.toContain('IMG_0001.JPG');
  },
);

// --- concurrency -----------------------------------------------------------

Then('the number of parallel uploads is chosen automatically by default', async ({ app }) => {
  // The Upload step reports "adaptive" instead of a slider (the row also holds
  // the 'i' explainer, so the text isn't an exact match).
  await expect(app.page.getByText(/^adaptive/)).toBeVisible();
  await expect(app.page.getByRole('button', { name: 'About adaptive concurrency' })).toBeVisible();
  await expect(app.laneSlider()).toHaveCount(0);
  await app.gotoSection('Settings');
  await expect(app.concurrencyModeRadio('Adaptive (default)')).toBeChecked();
  await app.gotoSection('New upload');
});

Then('it can be pinned to a number between 4 and 32', async ({ app }) => {
  await app.pinConcurrency(12);
  const slider = app.laneSlider();
  await expect(slider).toHaveAttribute('min', '4');
  await expect(slider).toHaveAttribute('max', '32');
  await expect(slider).toHaveValue('12');
});

Then('a pinned number defaults to 8', async ({ app }) => {
  // A fresh tab starts from the shipped defaults, so this reads the default
  // lane count rather than the 12 the previous step pinned in this session.
  await app.reopenInNewTab();
  await expect(app.connectForm()).toBeVisible();
  await app.fillConnection();
  await app.page.getByRole('button', { name: 'Connect', exact: true }).click();
  await app.dropFolder(standardBatch());
  await app.waitForInspected();
  await app.walkToUploadStep();
  await app.pinConcurrency();
  await expect(app.laneSlider()).toHaveValue('8');
});

Then('a pinned number can be changed while a run is in progress', async ({ app }) => {
  app.s3.putDelayMs = 1000;
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect(app.runPhase()).toHaveText('uploading');
  await expect(app.dryRunCheckbox()).toBeDisabled();
  // The lane pool re-reads the setting on every pull, so the slider stays live
  // — unlike the run options, which are locked once bytes are moving.
  await expect(app.laneSlider()).toBeEnabled();
  await app.laneSlider().fill('6');
  await expect(app.laneSlider()).toHaveValue('6');
  await app.waitForRunPhase('done', 120_000);
});

// --- retries and hard failures ---------------------------------------------

Given(
  "a file's upload fails with a network error, a server error or a clock-skew rejection",
  async ({ app }) => {
    app.s3.putHooks.push((_b, key) =>
      key.endsWith('IMG_0002.JPG')
        ? { status: 503, code: 'ServiceUnavailable', message: 'try later' }
        : undefined,
    );
    await app.dryRunCheckbox().uncheck();
    await app.startRun();
    await app.waitForRunPhase('partial', 120_000);
  },
);

Then('it is retried up to five attempts with an increasing, randomized delay', async ({ app }) => {
  const log = await app.logText();
  for (const attempt of [2, 3, 4, 5]) {
    expect(log).toMatch(new RegExp(`retry [^\\s]*IMG_0002\\.JPG \\(attempt ${attempt}\\) after \\d+ms`));
  }
  expect(log).not.toContain('(attempt 6)');
  const delays = [...log.matchAll(/after (\d+)ms/g)].map((m) => Number(m[1]));
  expect(delays).toHaveLength(4);
  expect(Math.max(...delays)).toBeGreaterThan(Math.min(...delays));
});

Then('the retry is recorded in the activity log', async ({ app }) => {
  expect(await app.logText()).toContain('retry');
  expect(await app.logText()).toMatch(/failed [^\s]*IMG_0002\.JPG/);
});

Given("a file's upload is refused for lack of permission", async ({ app }) => {
  await rescanFromUpload(app, manyJpegs(24));
  // Pin the lanes so the abort has files left to skip — adaptive would be free
  // to open enough of them to finish the batch before the 403 lands.
  await app.pinConcurrency(4);
  app.s3.putDelayMs = 40;
  app.s3.putHooks.push((_b, key) =>
    key.endsWith('IMG_0000.JPG') ? { status: 403, code: 'AccessDenied', message: 'Access Denied' } : undefined,
  );
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('error', 120_000);
});

Then('the run stops immediately without working through the remaining files', async ({ app }) => {
  expect(mediaPuts(app).length).toBeLessThan(24);
  expect(app.s3.puts.some((p) => METADATA_NAMES.some((n) => p.key.endsWith(n)))).toBe(false);
});

Then('the failure is reported', async ({ app }) => {
  await expect(app.runPhase()).toHaveText('error');
  await expect(app.page.getByText(/Access Denied|AccessDenied|Forbidden|403/).first()).toBeVisible();
});

Given('ten files have failed independently in one run', async ({ app }) => {
  await rescanFromUpload(app, manyJpegs(14));
  app.s3.putHooks.push((_b, key) =>
    key.endsWith('.JPG') ? { status: 400, code: 'InvalidRequest', message: 'nope' } : undefined,
  );
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('error', 120_000);
});

Then(
  'the run stops and reports that the problem looks systemic rather than per-file',
  async ({ app }) => {
    await expect(
      app.page.getByText(/aborted after 10 file failures — the problem looks systemic, not per-file/).first(),
    ).toBeVisible();
  },
);

Given(
  'a run aborts systemically while some lanes are waiting for the network',
  async ({ app }) => {
    await rescanFromUpload(app, manyJpegs(4));
    await app.pinConcurrency(4);
    await app.page.evaluate(() => {
      Math.random = () => 1;
    });

    let markOffline!: () => void;
    const offline = new Promise<void>((resolve) => { markOffline = resolve; });
    app.s3.putHooks.push(async (_bucket, key) => {
      if (key.endsWith('IMG_0000.JPG')) {
        await app.page.evaluate(() => {
          Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
        });
        markOffline();
        return { status: 503, code: 'ServiceUnavailable', message: 'try later' };
      }
      if (key.endsWith('IMG_0001.JPG')) {
        await offline;
        // Let the sibling enter retry backoff before this fatal response makes
        // the supervisor abort every lane.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: 403, code: 'AccessDenied', message: 'Access Denied' };
      }
      return undefined;
    });

    app.notes.systemicAbortStartedAt = Date.now();
    await app.dryRunCheckbox().uncheck();
    await app.startRun();
  },
);

Then('the error screen is shown immediately', async ({ app }) => {
  await app.waitForRunPhase('error', 10_000);
  await expect(app.page.getByText(/Access Denied|AccessDenied|Forbidden|403/).first()).toBeVisible();
});

Then(
  'the run does not wait for the network to return before reporting the failure',
  async ({ app }) => {
    expect(Date.now() - (app.notes.systemicAbortStartedAt as number)).toBeLessThan(10_000);
    expect(await app.page.evaluate(() => navigator.onLine)).toBe(false);
  },
);

// --- never overwrite -------------------------------------------------------

Given('an object already exists at a path the run intends to write', async ({ app }) => {
  // Storage already holds something at the key the run is about to claim.
  app.s3.putHooks.push((bucket, key) => {
    if (key.endsWith('IMG_0002.JPG') && !app.s3.has(bucket, key)) {
      app.s3.put(bucket, key, 'someone else was here first');
    }
    return undefined;
  });
});

When('a fresh upload attempts that write', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('error', 120_000);
});

Then('the write is refused rather than replacing the existing object', async ({ app }) => {
  const clash = [...app.s3.objects.entries()].find(([k]) => k.endsWith('IMG_0002.JPG'))!;
  expect(clash[1].body.toString('utf8')).toBe('someone else was here first');
  expect(app.s3.puts.some((p) => p.key.endsWith('IMG_0002.JPG'))).toBe(false);
});

Then('the run reports the failure', async ({ app }) => {
  await expect(app.runPhase()).toHaveText('error');
  await expect(app.page.getByText(/Object already exists at/).first()).toBeVisible();
});

// --- cancelling ------------------------------------------------------------

When('a run is cancelled', async ({ app }) => {
  holdFirstMediaPut(app);
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect.poll(() => app.s3.puts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  app.notes.storedAtCancel = app.s3.writtenKeys();
  await app.page.getByRole('button', { name: 'Cancel' }).click();
});

Then('in-flight transfers are abandoned', async ({ app }) => {
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
  const after = app.s3.puts.length;
  await app.page.waitForTimeout(1500);
  expect(app.s3.puts.length).toBe(after);
  expect(app.s3.puts.some((p) => p.key.endsWith('UploadMeta.json'))).toBe(false);
});

Then('the run is reported as cancelled', async ({ app }) => {
  await expect(app.page.getByText('cancelled').first()).toBeVisible();
  await expect(app.runPhase()).toHaveText('error');
});

Then('files already stored remain stored', async ({ app }) => {
  for (const key of app.notes.storedAtCancel as string[]) {
    const [bucket, ...rest] = key.split('/');
    expect(app.s3.has(bucket, rest.join('/'))).toBe(true);
  }
});

// --- guards and the next batch ---------------------------------------------

Then('the Back button is disabled', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Back' })).toBeDisabled();
});

Given('a real upload has completed', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

When('"Next batch" is chosen', async ({ app }) => {
  await app.page.getByRole('button', { name: 'Next batch' }).click();
});

Then('the wizard returns to the Files step with an empty batch', async ({ app }) => {
  await app.expectStep('Files');
  await expect(app.page.getByText('Drop a folder of media')).toBeVisible();
  await expect(app.fileListPane()).toHaveCount(0);
});

Then(
  'the collection, deployment, uploader identity, description and timezone of the previous batch are kept',
  async ({ app }) => {
    await app.dropFolder(standardBatch());
    await app.waitForInspected();
    await app.continueToAssign();
    await app.waitForCollections();
    await expect(app.collectionTrigger()).toContainText(COLLECTION_A_NAME);
    await expect(app.deploymentTrigger()).toContainText('Bear Canyon');
    await expect(app.page.getByPlaceholder('e.g. John Doe')).toHaveValue('Ada Lovelace');
    await expect(
      app.page.getByPlaceholder('What this batch is — site, date range, notes.'),
    ).toHaveValue('July retrieval');
    await expect(app.timeZoneSelect()).toHaveValue('America/Phoenix');
  },
);

// --- wake lock and preparing phase -------------------------------------------

Given('the browser wake lock API is available in this session', async ({ app }) => {
  await app.page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__wakeLockCount = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      value: {
        request: async (_type: string) => {
          (window as unknown as Record<string, unknown>).__wakeLockCount =
            ((window as unknown as Record<string, unknown>).__wakeLockCount as number) + 1;
          return { type: 'screen', released: false, release: async () => {} };
        },
      },
      configurable: true,
    });
  });
});

Given('the first media blob is held at the mock', async ({ app }) => {
  holdFirstMediaPut(app);
});

When('a real upload is started', async ({ app }) => {
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await expect.poll(() => app.s3.puts.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

When('the dry run is started and completes', async ({ app }) => {
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then('the activity log has the preparing-upload entry', async ({ app }) => {
  expect(await app.logText()).toContain('preparing upload…');
});

Then('the browser wake lock was requested', async ({ app }) => {
  const count = await app.page.evaluate(
    () => (window as unknown as Record<string, unknown>).__wakeLockCount as number,
  );
  expect(count).toBeGreaterThan(0);
});

Then('releasing the held blob lets the upload complete', async ({ app }) => {
  app.s3.releaseHeldPuts();
  await app.waitForRunPhase('done');
});
