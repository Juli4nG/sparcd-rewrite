import { Given, When, Then, expect } from './fixtures';
import { APP_PATH, type App } from './app';
import { writtenCsvRows } from './helpers';

// What the Tagger would have written back. Keys are the paths within the
// chosen folder — the same ids Inspect scanned with.
const TAGS = {
  'SDCARD/IMG_0001.JPG': [
    { scientificName: 'Canis latrans', commonName: 'Coyote', count: 2, requestedSpecies: '', freeTags: '' },
  ],
  'SDCARD/IMG_0002.JPG': [
    { scientificName: 'Casper', commonName: 'Ghost', count: 1, requestedSpecies: '', freeTags: '' },
  ],
  // IMG_0003.JPG is deliberately left alone.
};

const tagButton = (app: App) => app.page.getByRole('button', { name: 'Tag species first' });

/** Hand the batch over and stop at the Tagger's doorstep, holding its id. */
async function handOff(app: App): Promise<string> {
  await app.stubTagger();
  await tagButton(app).click();
  await app.page.waitForURL(/\/tagger\/\?batch=/);
  return new URL(app.page.url()).searchParams.get('batch')!;
}

/** Come back the way the Tagger's Done button does. */
async function handBack(app: App, id: string): Promise<void> {
  await app.page.goto(`${APP_PATH}?flip=${id}`);
}

// --- offering the hand-off --------------------------------------------------

Then('"Tag species first" sits between "Start over" and "Continue"', async ({ app }) => {
  const row = app.page.locator('button', { hasText: 'Start over' }).locator('..');
  const labels = await row.getByRole('button').allInnerTexts();
  expect(labels).toEqual(['Start over', 'Tag species first', 'Continue']);
});

Then('it is available exactly when Continue is', async ({ app }) => {
  await expect(tagButton(app)).toBeEnabled();
  await expect(app.continueButton()).toBeEnabled();
});

Then('"Tag species first" is unavailable', async ({ app }) => {
  await expect(tagButton(app)).toBeDisabled();
  await expect(app.continueButton()).toBeDisabled();
});

// --- handing over -----------------------------------------------------------

When('"Tag species first" is chosen', async ({ app }) => {
  app.notes.flipId = await handOff(app);
});

Then(
  'every examined file is handed over with everything the examination established',
  async ({ app }) => {
    const [record] = await app.readFlipRecords();
    expect(record.id).toBe(app.notes.flipId);
    const byPath = Object.fromEntries(record.files.map((f: any) => [f.relPath, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      'SDCARD/CLIP_0001.MP4',
      'SDCARD/IMG_0001.JPG',
      'SDCARD/IMG_0002.JPG',
      'SDCARD/IMG_0003.JPG',
    ]);

    const first = byPath['SDCARD/IMG_0001.JPG'];
    expect(first.fileName).toBe('IMG_0001.JPG');
    expect(first.size).toBeGreaterThan(0);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.mediaKind).toBe('image');
    expect(first.thumb).toBe(true);
    // The camera's own wall-clock, unconverted and in the camera's own slot —
    // the upload zone is applied later, when the bundle is built.
    expect(first.exifTimestamp).toBe('2026-07-01T12:00:00');
    expect(first.manualTimestamp).toBeUndefined();
    // The worker's own sniff, not a guess from the file extension. This one
    // reaches media.csv, so losing it would change what gets published.
    expect(first.mimeType).toBe('image/jpeg');
    expect(first.width).toBeGreaterThan(0);
    expect(first.height).toBeGreaterThan(0);

    const clip = byPath['SDCARD/CLIP_0001.MP4'];
    expect(clip.mediaKind).toBe('video');
    expect(clip.mimeType).toBe('video/mp4');
    expect(clip.exifTimestamp).toBe('2026-07-01T12:30:00');
  },
);

Then("the browser goes to the Tagger carrying the batch's id", async ({ app }) => {
  expect(app.page.url()).toContain(`/sparcd-exploration/tagger/?batch=${app.notes.flipId}`);
});

// --- real cross-tool hand-off through the issue #73 proxy ------------------

When('"Tag species first" is chosen through the unified dev origin', async ({ app }) => {
  await tagButton(app).click();
  await app.page.waitForURL(/localhost:5310\/sparcd-exploration\/tagger\/\?batch=/);
  app.notes.flipId = new URL(app.page.url()).searchParams.get('batch')!;
});

Then('the real Tagger opens the batch written by the Uploader', async ({ app }) => {
  await expect(app.page.getByText('Local batch · 4 files · from Uploader')).toBeVisible();
  for (const name of ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0003.JPG', 'CLIP_0001.MP4']) {
    await expect(app.page.locator(`button[title="${name}"]`)).toBeVisible();
  }
  const [record] = await app.readFlipRecords();
  expect(record.id).toBe(app.notes.flipId);
  expect(record.files).toHaveLength(4);
});

When('Coyote is applied in the real Tagger', async ({ app }) => {
  const image = app.page.locator('button[title="IMG_0002.JPG"]');
  await image.click();
  const coyote = app.page.locator('div.group').filter({ hasText: 'Canis latrans' }).first();
  await coyote.locator('button[title^="Apply"]').click();
  await expect(image).toContainText('Coyote');
});

When('the real Tagger hands the batch back', async ({ app }) => {
  await app.page.getByRole('button', { name: 'Done · back to Uploader' }).click();
  await app.page.waitForURL(/localhost:5310\/sparcd-exploration\/uploader\/\?flip=/);
  // A navigation resets the fake picker. Re-selecting the original dragged
  // folder is the real UI's expected return path and does not seed IndexedDB.
  await app.seedPickedFolder(app.lastSpecs);
  await app.page.getByRole('button', { name: 'Choose folder' }).click();
  await expect(app.fileListPane()).toBeVisible();
});

Then('the Uploader receives Coyote from the shared hand-off record', async ({ app }) => {
  await app.expectStep('Inspect');
  const rows = await app.listedFiles();
  const image = rows.find((row) => row.name === 'IMG_0002.JPG');
  expect(image?.species).toBe('Coyote×1');
});

// --- coming back ------------------------------------------------------------

Given('a batch was tagged in the Tagger and handed back', async ({ app }) => {
  const id = await handOff(app);
  app.notes.flipId = id;
  await app.patchFlipRecord(id, { tags: TAGS, taggerUser: 'anita' });
  await handBack(app, id);
  // A dragged-in folder never had a durable handle, so the folder is chosen
  // again — and the fake picker is reset by the navigation, so re-seed it.
  await app.seedPickedFolder(app.lastSpecs);
  await app.page.getByRole('button', { name: 'Choose folder' }).click();
  await expect(app.fileListPane()).toBeVisible();
});

Given('a batch tagged in the Tagger is handed back with no remembered folder', async ({ app }) => {
  const id = await handOff(app);
  app.notes.flipId = id;
  await app.patchFlipRecord(id, { tags: TAGS });
  await handBack(app, id);
  await app.seedPickedFolder(app.lastSpecs);
});

Given(
  'a batch tagged in the Tagger is handed back with a folder the browser will not reopen',
  async ({ app }) => {
    const id = await handOff(app);
    app.notes.flipId = id;
    // A stored folder the browser will not hand over without being asked: it
    // answers neither queryPermission nor requestPermission.
    await app.patchFlipRecord(id, {
      tags: TAGS,
      dirHandle: { kind: 'directory', name: 'SDCARD' },
    });
    await handBack(app, id);
  },
);

Then('the wizard is on the Inspect step with the same files', async ({ app }) => {
  await app.expectStep('Inspect');
  expect(await app.fileCount()).toBe(4);
});

Then(
  'each file still shows the capture time and pixel size the examination found',
  async ({ app }) => {
    // Nothing was examined a second time on the way back, so these can only be
    // here if the hand-off carried them.
    const rows = await app.listedFiles();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['IMG_0001.JPG'].timestamp).toBe('2026-07-01 12:00:00');
    expect(byName['IMG_0001.JPG'].dimensions).toMatch(/^\d+×\d+$/);
    expect(byName['CLIP_0001.MP4'].timestamp).toBe('2026-07-01 12:30:00');
  },
);

Then('each tagged file shows the species and count it was given', async ({ app }) => {
  const rows = await app.listedFiles();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName['IMG_0001.JPG'].species).toBe('Coyote×2');
  expect(byName['IMG_0002.JPG'].species).toBe('Ghost');
});

Then('files left untagged are shown as untagged', async ({ app }) => {
  const rows = await app.listedFiles();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName['IMG_0003.JPG'].species).toBe('untagged');
  expect(byName['CLIP_0001.MP4'].species).toBe('untagged');
});

Then('the summary says how many files are tagged', async ({ app }) => {
  expect(await app.batchSummary()).toContain('2 tagged');
});

Then('the action row offers "Edit tags" instead of "Tag species first"', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Edit tags' })).toBeEnabled();
  await expect(tagButton(app)).toHaveCount(0);
});

Then('choosing it returns to the Tagger with the same batch id', async ({ app }) => {
  await app.page.getByRole('button', { name: 'Edit tags' }).click();
  await app.page.waitForURL(/\/tagger\/\?batch=/);
  expect(new URL(app.page.url()).searchParams.get('batch')).toBe(app.notes.flipId);
});

Then('choosing the folder again puts the batch back on the Inspect step', async ({ app }) => {
  await expect(app.page.getByRole('heading', { name: 'Choose the folder again' })).toBeVisible();
  await app.page.getByRole('button', { name: 'Choose folder' }).click();
  await app.expectStep('Inspect');
  expect(await app.fileCount()).toBe(4);
});

Then('a "Reopen batch" button is offered instead of the file list', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Reopen batch' })).toBeVisible();
  await expect(app.fileListPane()).toHaveCount(0);
});

// --- publishing what came back ---------------------------------------------

When('it is published', async ({ app }) => {
  await app.walkToUploadStep();
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

When('a dry run of it is started', async ({ app }) => {
  await app.walkToUploadStep();
  await app.dryRunCheckbox().check();
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then('all stored objects pass the final review', async ({ app }) => {
  await expect(
    app.page.getByText(/final review: all \d+ objects confirmed/),
  ).toBeVisible();
});

Then('nothing about the hand-off is left on this machine', async ({ app }) => {
  await expect.poll(async () => (await app.readFlipRecords()).length).toBe(0);
});

Then('the hand-off is still on this machine', async ({ app }) => {
  const records = await app.readFlipRecords();
  expect(records.map((r) => r.id)).toEqual([app.notes.flipId]);
});

Then(
  'observations.csv has one row per species applied, against the right image',
  async ({ app }) => {
    const rows = writtenCsvRows(app, 'observations.csv');
    const media = Object.fromEntries(writtenCsvRows(app, 'media.csv').map((r) => [r[6], r[0]]));
    const animal = rows.filter((r) => r[5] === 'animal');
    const byName = Object.fromEntries(animal.map((r) => [r[8], r]));
    expect(byName['Canis latrans'][0]).toBe('SDCARD/IMG_0001.JPG:0');
    expect(byName['Canis latrans'][3]).toBe(media['IMG_0001.JPG']);
    expect(byName['Canis latrans'][9]).toBe('2');
    expect(byName['Casper'][0]).toBe('SDCARD/IMG_0002.JPG:0');
    expect(byName['Casper'][3]).toBe(media['IMG_0002.JPG']);
    expect(byName['Casper'][9]).toBe('1');
  },
);

Then('each row carries the common name the tagger used', async ({ app }) => {
  const comments = writtenCsvRows(app, 'observations.csv').map((r) => r[19]);
  expect(comments).toContain('[COMMONNAME:Coyote]');
  expect(comments).toContain('[COMMONNAME:Ghost]');
});

Then('the upload metadata counts every identified image, empty frames included', async ({ app }) => {
  const meta = JSON.parse(app.s3.puts.find((p) => p.key.endsWith('UploadMeta.json'))!.body);
  expect(meta.imageCount).toBe(4);
  // The coyote and the frame marked empty both count — camtrap's definition
  // (Ghost is species-present), so this number agrees with a later tagger sync.
  expect(meta.imagesWithSpecies).toBe(2);
});

Then('the untagged files have no species-identified observation row', async ({ app }) => {
  const media = Object.fromEntries(writtenCsvRows(app, 'media.csv').map((r) => [r[6], r[0]]));
  const animalMedia = new Set(
    writtenCsvRows(app, 'observations.csv').filter((r) => r[5] === 'animal').map((r) => r[3]),
  );
  expect(animalMedia.has(media['IMG_0003.JPG'])).toBe(false);
  expect(animalMedia.has(media['CLIP_0001.MP4'])).toBe(false);
});

Then('they are still in media.csv like every other image', async ({ app }) => {
  const names = writtenCsvRows(app, 'media.csv').map((r) => r[6]);
  expect(names).toContain('IMG_0003.JPG');
  expect(names).toContain('CLIP_0001.MP4');
});

Then('every media row carries the media type the examination sniffed', async ({ app }) => {
  const byName = Object.fromEntries(writtenCsvRows(app, 'media.csv').map((r) => [r[6], r[7]]));
  expect(byName['IMG_0001.JPG']).toBe('image/jpeg');
  expect(byName['CLIP_0001.MP4']).toBe('video/mp4');
});
