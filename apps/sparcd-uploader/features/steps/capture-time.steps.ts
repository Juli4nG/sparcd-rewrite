import { Given, When, Then, expect } from './fixtures';
import type { App } from './app';
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

// --- times the camera did not write ---------------------------------------

// IMG_0002 sits between two timestamped files (interpolated); IMG_0004 runs off
// the end of the batch (offset). One batch exercises both estimate methods.
const gappyBatch = () => [
  jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
  jpegNoTime('IMG_0002.JPG'),
  jpegAt('IMG_0003.JPG', '2026:07:01 12:10:00'),
  jpegNoTime('IMG_0004.JPG'),
];

/** The affected-files card for one file: its whole clickable face. */
const card = (app: App, fileName: string) =>
  app.page.getByRole('button', { name: new RegExp(fileName.replace('.', '\\.')) });

Given('some examined files carry no camera capture time', async ({ app }) => {
  await rescanFromAssign(app, gappyBatch());
  await app.chooseDeployment('Bear Canyon');
});

Then('each of them already shows an estimated time, marked as an estimate', async ({ app }) => {
  await expect(app.page.getByRole('heading', { name: 'Capture times' })).toBeVisible();
  await expect(app.page.getByText('2 without camera time')).toBeVisible();
  await expect(card(app, 'IMG_0002.JPG')).toContainText('2026-07-01 12:05:00');
  await expect(card(app, 'IMG_0002.JPG')).toContainText('EST.');
  await expect(card(app, 'IMG_0004.JPG')).toContainText('2026-07-01 12:20:00');
  await expect(card(app, 'IMG_0003.JPG')).toHaveCount(0); // it has a camera time
});

Then('a file between two timestamped files sits midway between them', async ({ app }) => {
  await expect(app.page.getByText('between IMG_0001.JPG and IMG_0003.JPG')).toBeVisible();
  await expect(app.page.getByText('10 min after IMG_0003.JPG (last file)')).toBeVisible();
});

Given('the batch begins and ends with a file carrying no camera time', async ({ app }) => {
  await rescanFromAssign(app, [
    jpegNoTime('IMG_0000.JPG'),
    jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
    jpegNoTime('IMG_0002.JPG'),
  ]);
});

Then('the first file sits ten minutes before the earliest camera time', async ({ app }) => {
  await expect(card(app, 'IMG_0000.JPG')).toContainText('2026-07-01 11:50:00');
  await expect(app.page.getByText('10 min before IMG_0001.JPG (first file)')).toBeVisible();
});

Then('the last file sits ten minutes after the latest camera time', async ({ app }) => {
  await expect(card(app, 'IMG_0002.JPG')).toContainText('2026-07-01 12:10:00');
  await expect(app.page.getByText('10 min after IMG_0001.JPG (last file)')).toBeVisible();
});

Given('no file in the batch carries a camera capture time', async ({ app }) => {
  await rescanFromAssign(app, [jpegNoTime('IMG_0001.JPG'), jpegNoTime('IMG_0002.JPG')]);
});

Then('every file takes the time its file was last modified', async ({ app }) => {
  await expect(app.page.getByText(/^file modified time \(.+\)$/)).toHaveCount(2);
  // The exact instant is the browser's File.lastModified, so pin the shape only.
  await expect(card(app, 'IMG_0001.JPG')).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

Then('the panel says so, and offers to spread the times instead', async ({ app }) => {
  await expect(
    app.page.getByText('No file in this batch has a camera capture time.'),
  ).toBeVisible();
  await expect(app.page.getByText('Use Spread if the file dates are wrong too.')).toBeVisible();
  await expect(app.page.getByRole('tab', { name: 'Spread from a start time' })).toBeVisible();
});

// --- overriding an estimate ------------------------------------------------

const overrideInput = (app: App) => app.page.locator('input[type="datetime-local"]');

When("a time is typed over one file's estimate", async ({ app }) => {
  await card(app, 'IMG_0002.JPG').click();
  await overrideInput(app).fill('2026-05-05T05:05:05');
});

Then('that file shows the typed time as entered by hand', async ({ app }) => {
  await expect(card(app, 'IMG_0002.JPG')).toContainText('2026-05-05 05:05:05');
  await expect(card(app, 'IMG_0002.JPG')).toContainText('MANUAL');
});

Then('clearing it returns the file to its estimate', async ({ app }) => {
  await app.page
    .getByRole('button', { name: '✕ back to estimate (2026-07-01 12:05:00)' })
    .click();
  await expect(card(app, 'IMG_0002.JPG')).toContainText('2026-07-01 12:05:00');
  await expect(card(app, 'IMG_0002.JPG')).toContainText('EST.');
});

When('a start time and a spacing are applied to the selection', async ({ app }) => {
  await app.page.getByRole('radio', { name: 'All estimated' }).click();
  await app.page.getByRole('tab', { name: 'Spread from a start time' }).click();
  await app.page.getByLabel('First image capture time').fill('2026-07-01T09:00:15');
  await app.page.getByLabel('Spacing in seconds').fill('60');
  await expect(
    app.page.getByText('2 files land 2026-07-01 09:00:15 → 09:01:15, in filename order.'),
  ).toBeVisible();
  await app.page.getByRole('button', { name: 'Apply to 2 files' }).click();
});

Then('the files land at that start time, one spacing apart, in filename order', async ({ app }) => {
  await expect(card(app, 'IMG_0002.JPG')).toContainText('2026-07-01 09:00:15');
  await expect(card(app, 'IMG_0004.JPG')).toContainText('2026-07-01 09:01:15');
});

Then('each of them is marked as spread', async ({ app }) => {
  await expect(app.page.getByText('SPREAD', { exact: true })).toHaveCount(2);
});

When('a date that does not exist is entered, such as 31 February', async ({ app }) => {
  await rescanFromAssign(app, gappyBatch());
  await card(app, 'IMG_0002.JPG').click();
  await app.setControlledValue('input[type="datetime-local"]', '2026-02-31T10:00:00', 0);
});

Then('the file keeps the estimate it already had', async ({ app }) => {
  await expect(card(app, 'IMG_0002.JPG')).toContainText('2026-07-01 12:05:00');
  await expect(card(app, 'IMG_0002.JPG')).toContainText('EST.');
});

// --- what a batch with estimates publishes ---------------------------------

Then('the deployment is flagged as having a timestamp issue', async ({ app }) => {
  const rows = writtenCsvRows(app, 'deployments.csv');
  expect(rows[0][15]).toBe('true');
});

Then('each file whose time the camera did not write carries a marker saying where it came from', async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  expect(rows.find((r) => r[6] === 'IMG_0002.JPG')![10]).toBe('[TIMESTAMP:interpolated]');
  expect(rows.find((r) => r[6] === 'IMG_0004.JPG')![10]).toBe('[TIMESTAMP:offset]');
});

Then('files the camera did time carry no marker', async ({ app }) => {
  const rows = writtenCsvRows(app, 'media.csv');
  expect(rows.find((r) => r[6] === 'IMG_0001.JPG')![10]).toBe('');
  expect(rows.find((r) => r[6] === 'IMG_0002.JPG')![4]).toBe('2026-07-01T19:05:00.000Z');
});

Then('the batch can be published without anyone entering a time', async ({ app }) => {
  await expect(app.continueButton()).toBeEnabled();
  await expect(app.continueButton()).toHaveAttribute('title', 'Continue to upload');
});
