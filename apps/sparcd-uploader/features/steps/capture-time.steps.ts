import { Given, When, Then, expect } from './fixtures';
import { clipVideo, jpegAt, jpegNoTime, standardBatch } from './batches';
import { rescanFromAssign, writtenCsvRows } from './helpers';
import { LEGACY_ZONE } from './fixtures-data';

const MACHINE_ZONE = 'America/New_York'; // playwright.config.ts pins this
const BEAR_CANYON_ZONE = 'America/Phoenix'; // where 32.4, -110.7 falls

Given('a scanned batch has reached the Assign step', async ({ app }) => {
  await app.connect();
  await app.dropFolder(standardBatch());
  await app.waitForInspected();
  await app.continueToAssign();
  await app.waitForCollections();
});

// --- the upload timezone ---------------------------------------------------

Given('no deployment has been chosen yet', async ({ app }) => {
  await expect(app.deploymentTrigger()).toContainText('Select a deployment location…');
});

Then('the upload timezone is the timezone of the machine doing the upload', async ({ app }) => {
  const browserZone = await app.page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(browserZone).toBe(MACHINE_ZONE);
  await expect(app.timeZoneSelect()).toHaveValue(MACHINE_ZONE);
});

When('a deployment location is chosen', async ({ app }) => {
  await app.chooseDeployment('Bear Canyon');
});

Then("the upload timezone changes to the timezone the location's coordinates fall in", async ({ app }) => {
  await expect(app.timeZoneSelect()).toHaveValue(BEAR_CANYON_ZONE);
  expect(BEAR_CANYON_ZONE).not.toBe(MACHINE_ZONE);
});

Given('a deployment location has been chosen', async ({ app }) => {
  await app.chooseDeployment('Bear Canyon');
  await expect(app.timeZoneSelect()).toHaveValue(BEAR_CANYON_ZONE);
});

When('the user then picks a different timezone', async ({ app }) => {
  await app.timeZoneSelect().selectOption('Europe/Berlin');
  await expect(app.timeZoneSelect()).toHaveValue('Europe/Berlin');
});

Then('that choice stands for as long as the same location stays selected', async ({ app }) => {
  await app.setUploader('Ada Lovelace');
  await app.setDescription('unchanged zone');
  await app.chooseDeployment('Bear Canyon'); // re-picking the same location
  await expect(app.timeZoneSelect()).toHaveValue('Europe/Berlin');
  // Picking a different location does re-derive it.
  await app.chooseDeployment('Coyote Wash');
  await expect(app.timeZoneSelect()).toHaveValue(BEAR_CANYON_ZONE);
});

Then('the timezone list offers every timezone the browser knows', async ({ app }) => {
  const known = await app.page.evaluate(() => Intl.supportedValuesOf('timeZone'));
  const offered = await app.timeZoneSelect().locator('option').allTextContents();
  expect(offered).toEqual(known);
});

Then('the currently chosen timezone is always offered even if it is not in that list', async ({ app }) => {
  const known = await app.page.evaluate(() => Intl.supportedValuesOf('timeZone'));
  expect(known).not.toContain(LEGACY_ZONE);
  await app.chooseDeployment('Offshore Buoy');
  await expect(app.timeZoneSelect()).toHaveValue(LEGACY_ZONE);
  const offered = await app.timeZoneSelect().locator('option').allTextContents();
  expect(offered[0]).toBe(LEGACY_ZONE);
  expect(offered).toHaveLength(known.length + 1);
});

// --- what gets stored ------------------------------------------------------

Given('a file whose camera wrote a wall-clock time', async ({ app }) => {
  await rescanFromAssign(app, [
    jpegAt('SUMMER.JPG', '2026:07:01 12:00:00'),
    jpegAt('WINTER.JPG', '2026:01:15 12:00:00'),
    clipVideo(),
  ]);
  await app.chooseDeployment('Bear Canyon');
  // Berlin so both a DST and a non-DST date are exercised, and so the result
  // cannot coincide with the uploading machine's own zone.
  await app.timeZoneSelect().selectOption('Europe/Berlin');
});

When('the batch is published', async ({ app }) => {
  await app.continueToUpload();
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
});

Then('the stored capture time is that wall-clock read in the upload timezone', async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  const summer = rows.find((r) => r[6] === 'SUMMER.JPG')!;
  expect(summer[4]).toBe('2026-07-01T10:00:00.000Z'); // 12:00 CEST = 10:00Z
});

Then('daylight-saving time in force on that date is accounted for', async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  const winter = rows.find((r) => r[6] === 'WINTER.JPG')!;
  expect(winter[4]).toBe('2026-01-15T11:00:00.000Z'); // 12:00 CET = 11:00Z
});

Then('the stored time does not depend on the timezone of the machine uploading', async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  const summer = rows.find((r) => r[6] === 'SUMMER.JPG')!;
  // In the machine's own zone (America/New_York, UTC-4 in July) the same
  // wall-clock would have become 16:00Z.
  expect(summer[4]).not.toBe('2026-07-01T16:00:00.000Z');
});

// --- manual entry ----------------------------------------------------------

Given('some examined files carry no camera capture time', async ({ app }) => {
  await rescanFromAssign(app, [
    jpegAt('IMG_TIMED.JPG', '2026:07:01 12:00:00'),
    jpegNoTime('IMG_A.JPG'),
    jpegNoTime('IMG_B.JPG'),
  ]);
});

Then('the Assign step lists exactly those files with a time field each', async ({ app }) => {
  await expect(app.page.getByRole('heading', { name: 'Capture time' })).toBeVisible();
  const rows = app.page.locator('input[type="datetime-local"]');
  // One bulk field plus one per file that has no camera time.
  await expect(rows).toHaveCount(3);
  const labels = await app.page.locator('[aria-label^="Clear capture time"], .max-h-\\[280px\\] span[title]').allTextContents();
  expect(labels.join(' ')).toContain('IMG_A.JPG');
  expect(labels.join(' ')).toContain('IMG_B.JPG');
  expect(labels.join(' ')).not.toContain('IMG_TIMED.JPG');
});

Then('it states how many of them still have no time', async ({ app }) => {
  await expect(app.page.getByText('2 of 2 file(s) still need a capture time.')).toBeVisible();
});

Given('several files are still missing a capture time', async ({ app }) => {
  await rescanFromAssign(app, [
    jpegAt('IMG_TIMED.JPG', '2026:07:01 12:00:00'),
    jpegNoTime('IMG_A.JPG'),
    jpegNoTime('IMG_B.JPG'),
  ]);
  // Give one of them a time by hand first, so the bulk apply has something to
  // leave alone.
  await app.page.locator('input[type="datetime-local"]').nth(1).fill('2026-05-05T05:05:05');
  await expect(app.page.getByText('1 of 2 file(s) still need a capture time.')).toBeVisible();
});

When('a time is entered once and applied in bulk', async ({ app }) => {
  await app.page.locator('input[type="datetime-local"]').first().fill('2026-09-09T09:09:09');
  await app.page.getByRole('button', { name: /^Apply to \d+ unset$/ }).click();
});

Then('every file that had no time receives it', async ({ app }) => {
  await expect(app.page.locator('input[type="datetime-local"]').nth(2)).toHaveValue('2026-09-09T09:09:09');
  await expect(
    app.page.getByText('All 2 previously-missing file(s) now have a manual capture time.'),
  ).toBeVisible();
});

Then('files that already had a time keep the one they had', async ({ app }) => {
  await expect(app.page.locator('input[type="datetime-local"]').nth(1)).toHaveValue('2026-05-05T05:05:05');
});

Given('a file whose camera wrote a capture time', async ({ app }) => {
  await rescanFromAssign(app, [jpegAt('IMG_TIMED.JPG', '2026:07:01 12:00:00'), jpegNoTime('IMG_A.JPG')]);
  await app.chooseDeployment('Bear Canyon');
});

Then('it is not offered for manual entry', async ({ app }) => {
  await expect(app.page.getByRole('heading', { name: 'Capture time' })).toBeVisible();
  const titles = await app.page.locator('input[type="datetime-local"]').count();
  expect(titles).toBe(2); // bulk field + the one untimed file
  await expect(app.page.getByTitle('SDCARD/IMG_TIMED.JPG')).toHaveCount(0);
});

Then("the camera's time is what gets stored", async ({ app }) => {
  await app.page.locator('input[type="datetime-local"]').nth(1).fill('2026-05-05T05:05:05');
  await app.continueToUpload();
  await app.dryRunCheckbox().uncheck();
  await app.startRun();
  await app.waitForRunPhase('done');
  const rows = writtenCsvRows(app, 'media.csv');
  const csv = rows.flat().join(',');
  // Bear Canyon is America/Phoenix (UTC-7, no DST): 12:00 → 19:00Z.
  expect(csv).toContain('2026-07-01T19:00:00');
  expect(csv).not.toContain('2026-05-05T05:05:05');
});

When('a manually entered time is cleared', async ({ app }) => {
  await rescanFromAssign(app, [jpegAt('IMG_TIMED.JPG', '2026:07:01 12:00:00'), jpegNoTime('IMG_A.JPG')]);
  await app.chooseDeployment('Bear Canyon');
  await app.page.locator('input[type="datetime-local"]').nth(1).fill('2026-05-05T05:05:05');
  await expect(app.continueButton()).toBeEnabled();
  await app.page.getByRole('button', { name: /^Clear capture time for/ }).click();
});

Then('that file counts again as missing a capture time', async ({ app }) => {
  await expect(app.page.getByText('1 of 1 file(s) still need a capture time.')).toBeVisible();
});

Then('the batch cannot be published until it is given one', async ({ app }) => {
  await expect(app.continueButton()).toBeDisabled();
  await expect(app.continueButton()).toHaveAttribute(
    'title',
    'Set a capture time for every file missing one',
  );
});

When('a date that does not exist is entered, such as 31 February', async ({ app }) => {
  await rescanFromAssign(app, [jpegAt('IMG_TIMED.JPG', '2026:07:01 12:00:00'), jpegNoTime('IMG_A.JPG')]);
  await app.chooseDeployment('Bear Canyon');
  await app.setControlledValue('input[type="datetime-local"]', '2026-02-31T10:00:00', 1);
});

Then('it is not accepted as a capture time', async ({ app }) => {
  await expect(app.page.getByText('1 of 1 file(s) still need a capture time.')).toBeVisible();
  await expect(app.continueButton()).toBeDisabled();
  // A real date on the same field is accepted, so the field itself works.
  await app.setControlledValue('input[type="datetime-local"]', '2026-02-28T10:00:00', 1);
  await expect(app.continueButton()).toBeEnabled();
});

// --- publishing ------------------------------------------------------------

Given('every examined file has either a camera time or a manual one', async ({ app }) => {
  await rescanFromAssign(app, [jpegAt('IMG_TIMED.JPG', '2026:07:01 12:00:00'), jpegNoTime('IMG_A.JPG'), clipVideo()]);
  await app.chooseDeployment('Bear Canyon');
  await app.page.locator('input[type="datetime-local"]').nth(1).fill('2026-05-05T05:05:05');
  await expect(app.continueButton()).toBeEnabled();
});

Then('every media row carries a capture time', async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  expect(rows.length).toBe(3);
  for (const row of rows) expect(row[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+Z)?$/);
  expect(rows.find((r) => r[6] === 'IMG_A.JPG')![4]).toBe('2026-05-05T12:05:05.000Z');
});
