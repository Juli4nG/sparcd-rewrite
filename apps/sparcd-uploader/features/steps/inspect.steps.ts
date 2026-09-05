import { Given, When, Then, expect } from './fixtures';
import {
  FOLDER,
  jpegAt,
  jpegNoTime,
  manyJpegs,
  mp4At,
  publishableBatch,
  slowPublishableBatch,
  slowVideo,
  standardBatch,
} from './batches';
import { jpegWithExifDate } from './fixtures-data';

Given('a folder of media has been scanned', async ({ app }) => {
  await app.connect();
  await app.dropFolder([...standardBatch(), mp4At('CLIP_0001.MP4', new Date(Date.UTC(2026, 6, 1, 12, 30, 0)))]);
  await app.waitForInspected();
});

Given('the New upload section is showing the Inspect step', async ({ app }) => {
  await app.expectStep('Inspect');
  await expect(app.fileListPane()).toBeVisible();
});

// --- what Inspect establishes ---------------------------------------------

When('the batch is examined', async ({ app }) => {
  await app.waitForInspected();
});

Then("each file's capture time is read from the camera's own metadata", async ({ app }) => {
  const rows = await app.listedFiles();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName['IMG_0001.JPG'].timestamp).toBe('2026-07-01 12:00:00');
  expect(byName['IMG_0002.JPG'].timestamp).toBe('2026-07-01 12:05:00');
  // The MP4's time comes from the container's mvhd creation time, not EXIF.
  expect(byName['CLIP_0001.MP4'].timestamp).toBe('2026-07-01 12:30:00');
});

Then("each file's content fingerprint is computed from its bytes", async ({ app }) => {
  const rows = await app.listedFiles();
  expect(rows).toHaveLength(4);
  for (const row of rows) expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set(rows.map((r) => r.sha256)).size).toBe(4);
});

Then("each image's pixel dimensions and a thumbnail are produced", async ({ app }) => {
  const rows = await app.listedFiles();
  for (const row of rows.filter((r) => r.name.endsWith('.JPG'))) {
    expect(row.dimensions).toBe('64×48');
    expect(row.hasThumbnail).toBe(true);
  }
});

// --- the summary -----------------------------------------------------------

Given('files are still being examined', async ({ app }) => {
  // One file that blocks (unsafe path), one that only warns (no capture time),
  // one that is still being hashed, and one clean file.
  await app.rescan(
    [
      jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
      jpegNoTime('IMG_NOTIME.JPG'),
      { path: `${FOLDER}/../ESCAPE.JPG`, mime: 'image/jpeg', bytes: jpegWithExifDate('2026:07:01 12:00:00', 'esc') },
      slowVideo(),
    ],
    { raw: true },
  );
  await expect(app.fileListPane()).toBeVisible();
});

Then('the summary shows the file count, total size, and how many are still processing', async ({ app }) => {
  await expect
    .poll(() => app.batchSummary(), { timeout: 30_000 })
    .toMatch(/4 files · [\d.]+ (B|KB|MB) · \d+ processing/);
});

Then('it shows how many files need attention and how many carry warnings', async ({ app }) => {
  await expect.poll(() => app.batchSummary(), { timeout: 30_000 }).toMatch(/1 need attention/);
  await expect.poll(() => app.batchSummary(), { timeout: 30_000 }).toMatch(/1 warnings/);
});

// --- blocking problems -----------------------------------------------------

Given('one file fails to be examined', async ({ app }) => {
  await app.rescan([
    jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
    { path: `${FOLDER}/BROKEN.JPG`, mime: 'image/jpeg', broken: true },
  ]);
  await app.waitForInspected();
});

Then('that file is marked as needing attention', async ({ app }) => {
  const rows = await app.listedFiles();
  const bad = rows.find((r) => r.name === 'BROKEN.JPG' || r.name === 'ESCAPE.JPG')!;
  expect(bad.status).toBe('Needs attention');
});

Then('the batch cannot continue to the Assign step until it is resolved', async ({ app }) => {
  await expect(app.continueButton()).toBeDisabled();
  const rows = await app.listedFiles();
  await app.dropFileFromList(rows.findIndex((r) => r.name === 'BROKEN.JPG'));
  await expect(app.continueButton()).toBeEnabled();
});

Given("a file's path contains a traversal segment or is empty once normalized", async ({ app }) => {
  await app.rescan(
    [
      jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
      { path: `${FOLDER}/../ESCAPE.JPG`, mime: 'image/jpeg', bytes: jpegWithExifDate('2026:07:01 12:00:00', 'esc') },
    ],
    { raw: true },
  );
  await app.waitForInspected();
});

Then('the batch cannot continue until it is dropped', async ({ app }) => {
  await expect(app.continueButton()).toBeDisabled();
  const rows = await app.listedFiles();
  const i = rows.findIndex((r) => r.name === 'ESCAPE.JPG');
  expect(rows[i].issues).toContain('Unsafe filename');
  await app.dropFileFromList(i);
  await expect(app.continueButton()).toBeEnabled();
});

// --- warnings --------------------------------------------------------------

Given('a file carries no camera capture time', async ({ app }) => {
  await app.rescan([jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'), jpegNoTime('IMG_NOTIME.JPG')]);
  await app.waitForInspected();
});

Then('it is shown as a warning at Inspect', async ({ app }) => {
  const row = (await app.listedFiles()).find((r) => r.name === 'IMG_NOTIME.JPG')!;
  expect(row.status).toBe('Warning');
  expect(row.issues).toContain('No camera time');
});

Then('the batch can still continue to the Assign step, where the estimate can be overridden', async ({ app }) => {
  await expect(app.continueButton()).toBeEnabled();
  await app.continueToAssign();
  await expect(app.page.getByRole('heading', { name: 'Capture times' })).toBeVisible();
});

Given('two files in the batch have identical contents', async ({ app }) => {
  const twin = jpegWithExifDate('2026:07:01 12:00:00', 'same-bytes');
  await app.rescan([
    { path: `${FOLDER}/IMG_A.JPG`, mime: 'image/jpeg', bytes: twin },
    { path: `${FOLDER}/IMG_B.JPG`, mime: 'image/jpeg', bytes: twin },
    jpegAt('IMG_C.JPG', '2026:07:01 12:10:00'),
  ]);
  await app.waitForInspected();
});

Then('both are flagged as duplicates of each other', async ({ app }) => {
  const rows = await app.listedFiles();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName['IMG_A.JPG'].issues).toContain('Duplicate of another file');
  expect(byName['IMG_B.JPG'].issues).toContain('Duplicate of another file');
  expect(byName['IMG_A.JPG'].sha256).toBe(byName['IMG_B.JPG'].sha256);
  expect(byName['IMG_C.JPG'].issues).not.toContain('Duplicate');
});

Then('they are a warning, so the batch can proceed with them kept or dropped', async ({ app }) => {
  const rows = await app.listedFiles();
  expect(rows.find((r) => r.name === 'IMG_A.JPG')!.status).toBe('Warning');
  await expect(app.continueButton()).toBeEnabled();
  await app.dropFileFromList(rows.findIndex((r) => r.name === 'IMG_A.JPG'));
  await expect(app.continueButton()).toBeEnabled();
  expect(await app.fileCount()).toBe(2);
});

Given('a file is larger than 100 MiB', async ({ app }) => {
  await app.rescan([
    jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
    {
      path: `${FOLDER}/HUGE.JPG`,
      mime: 'image/jpeg',
      bytes: jpegWithExifDate('2026:07:01 12:20:00', 'huge'),
      padBytes: 101 * 1024 * 1024,
    },
  ]);
  await app.waitForInspected();
});

Then('it is flagged as unusually large for a camera trap', async ({ app }) => {
  const row = (await app.listedFiles()).find((r) => r.name === 'HUGE.JPG')!;
  expect(row.issues).toContain('Large file (>100 MiB)');
  expect(row.status).toBe('Warning');
});

Then('it does not block the batch', async ({ app }) => {
  await expect(app.continueButton()).toBeEnabled();
});

// --- dropping files --------------------------------------------------------

When('a file is removed from the list', async ({ app }) => {
  const twin = jpegWithExifDate('2026:07:01 12:00:00', 'twin');
  await app.rescan([
    { path: `${FOLDER}/IMG_A.JPG`, mime: 'image/jpeg', bytes: twin },
    { path: `${FOLDER}/IMG_B.JPG`, mime: 'image/jpeg', bytes: twin },
    jpegAt('IMG_C.JPG', '2026:07:01 12:10:00'),
  ]);
  await app.waitForInspected();
  const rows = await app.listedFiles();
  expect(rows.find((r) => r.name === 'IMG_B.JPG')!.issues).toContain('Duplicate');
  await app.dropFileFromList(rows.findIndex((r) => r.name === 'IMG_A.JPG'));
});

Then('it is excluded from the upload', async ({ app }) => {
  const names = (await app.listedFiles()).map((r) => r.name);
  expect(names).not.toContain('IMG_A.JPG');
  expect(await app.fileCount()).toBe(2);
});

Then('the duplicate warnings on the remaining files are recalculated', async ({ app }) => {
  const rows = await app.listedFiles();
  expect(rows.find((r) => r.name === 'IMG_B.JPG')!.issues).not.toContain('Duplicate');
  expect(await app.batchSummary()).not.toContain('warnings');
});

// --- the Continue gate -----------------------------------------------------

Given('at least one file is marked as needing attention', async ({ app }) => {
  await app.rescan([
    jpegAt('IMG_0001.JPG', '2026:07:01 12:00:00'),
    { path: `${FOLDER}/BROKEN.JPG`, mime: 'image/jpeg', broken: true },
  ]);
  await app.waitForInspected();
  expect((await app.listedFiles()).some((r) => r.status === 'Needs attention')).toBe(true);
});

Then('it explains that files needing attention must be resolved first', async ({ app }) => {
  await expect(app.continueButton()).toHaveAttribute(
    'title',
    'Resolve files that need attention first',
  );
});

// --- working while examination continues -----------------------------------

Given('a large batch is still being examined', async ({ app }) => {
  await app.holdInspect('BIG_CLIP.MP4');
  await app.rescan(publishableBatch());
  await expect(app.fileListPane()).toBeVisible();
  await expect.poll(() => app.batchSummary()).toMatch(/\d+ processing/);
});

Given('no file has been marked as needing attention', async ({ app }) => {
  expect(await app.batchSummary()).not.toContain('need attention');
});

Then('Continue is available', async ({ app }) => {
  await expect(app.continueButton()).toBeEnabled();
});

Then('examination carries on in the background while the user works on Assign', async ({ app }) => {
  await app.continueToAssign();
  await app.waitForCollections();
  await app.chooseDeployment('Bear Canyon');
  await app.continueToUpload();
  // The Upload step reports the still-running examination, then it completes
  // without anyone going back to Inspect.
  await expect(app.page.getByText(/still being inspected/)).toBeVisible();
  await app.releaseHeldInspect();
  await expect(app.page.getByText(/still being inspected/)).toHaveCount(0, { timeout: 60_000 });
  await expect(app.page.getByText(/^\d+ files ready · /)).toBeVisible();
});

Given('a batch is still being examined', async ({ app }) => {
  await app.rescan(manyJpegs(1200));
  await expect(app.fileListPane()).toBeVisible();
  await expect.poll(() => app.batchSummary()).toMatch(/\d+ processing/);
  const m = /(\d+) processing/.exec(await app.batchSummary());
  app.notes.pendingBefore = Number(m![1]);
});

When('the user switches to History or Settings and back', async ({ app }) => {
  await app.gotoSection('Settings');
  await expect(app.page.getByText('Uploader identity')).toBeVisible();
  await app.gotoSection('New upload');
  await expect(app.fileListPane()).toBeVisible();
});

Then('examination has continued in the background rather than restarting', async ({ app }) => {
  await expect
    .poll(
      async () => {
        const m = /(\d+) processing/.exec(await app.batchSummary());
        return m ? Number(m[1]) : 0;
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(app.notes.pendingBefore as number);
  await app.waitForInspected();
  expect(await app.fileCount()).toBe(1200);
});

When('"Start over" is chosen', async ({ app }) => {
  await app.page.getByRole('button', { name: 'Start over' }).click();
});

Then('the batch is cleared and the wizard returns to the Files step', async ({ app }) => {
  await app.expectStep('Files');
  await expect(app.page.getByText('Drop a folder of media')).toBeVisible();
  await expect(app.fileListPane()).toHaveCount(0);
});

// --- very large batches ----------------------------------------------------

Given('a batch of several thousand files', async ({ app }) => {
  await app.rescan(manyJpegs(3000));
  await expect(app.fileListPane()).toBeVisible();
  await expect.poll(() => app.fileCount(), { timeout: 60_000 }).toBe(3000);
});

Then('the list scrolls smoothly with only the visible rows drawn', async ({ app }) => {
  const drawn = await app.drawnRowCount();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(60);
  const first = (await app.listedFiles())[0].name;
  await app.fileListPane().evaluate((el) => {
    el.scrollTop = 20_000;
  });
  await expect.poll(async () => (await app.listedFiles())[0]?.name).not.toBe(first);
  expect(await app.drawnRowCount()).toBeLessThan(60);
});

Then('files can be stepped through and dropped from the keyboard', async ({ app }) => {
  await app.fileListPane().evaluate((el) => {
    el.scrollTop = 0;
  });
  await app.fileListPane().focus();
  await app.page.keyboard.press('j');
  await app.page.keyboard.press('j');
  await app.page.keyboard.press('k');
  await app.page.keyboard.press('d');
  await expect.poll(() => app.fileCount()).toBe(2999);
});
