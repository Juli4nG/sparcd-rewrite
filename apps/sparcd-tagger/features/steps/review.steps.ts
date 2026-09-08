import type { Page } from '@playwright/test';
import {
  Given,
  When,
  Then,
  expect,
  openWorkspace,
  focusFrame,
  gridCell,
  listRow,
  speciesApply,
  sectionTab,
  enterFocusView,
  selectCollection,
  openUpload,
} from './support/world';
import { BUCKET, PREFIX_A, MEDIA_A } from './support/data';
import { openSyncDialog, setSyncDryRun, readStore } from './support/flows';

const appliedChip = (page: Page, label: string) =>
  page.locator('span.inline-flex:not([data-testid="applied-species-summary"])').filter({ hasText: label }).first();

async function expandApplied(page: Page): Promise<void> {
  const summary = page.locator('button[title="Show all applied species"]');
  if (await summary.count()) await summary.click();
}

async function draftSpecies(page: Page, fileName: string): Promise<string[]> {
  const rows = (await readStore(page, 'drafts')) as {
    mediaPath: string;
    observations: { scientificName: string }[];
  }[];
  const row = rows.find((r) => r.mediaPath.endsWith(fileName));
  return (row?.observations ?? []).map((o) => o.scientificName);
}

const showList = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '☰ List' }).click();
};

Given('an upload with existing identifications is open in the tagging workspace', async ({ page }) => {
  await openWorkspace(page);
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer');
});

// --- What existing identifications look like --------------------------------

Then("each image's tile shows the species already recorded for it", async ({ page }) => {
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer ×2');
  await expect(gridCell(page, 'IMG003.JPG')).toContainText('Ghost');
  await expect(gridCell(page, 'IMG004.JPG')).toContainText('Mountain Lion');
});

Then('an image with several species shows the first with a count of the rest', async ({ page }) => {
  await expect(gridCell(page, 'IMG004.JPG')).toContainText('Mountain Lion +1');
});

Then('an image with no species is labelled "untagged" in the list view', async ({ page }) => {
  await showList(page);
  await expect(listRow(page, 'IMG002.JPG')).toContainText('untagged');
  // Deviation, verified: a GRID tile with no species shows its file name
  // instead of the word "untagged".
  await page.getByRole('button', { name: '▦ Grid' }).click();
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('IMG002.JPG');
  await expect(gridCell(page, 'IMG002.JPG')).not.toContainText('untagged');
});

Given('an image with existing identifications is focused', async ({ page }) => {
  await focusFrame(page, 'IMG004.JPG');
});

Then('each recorded species is shown with its count', async ({ page }) => {
  await expandApplied(page);
  await expect(appliedChip(page, 'Mountain Lion').locator('input[type="number"]')).toHaveValue('1');
  await expect(appliedChip(page, 'Coyote').locator('input[type="number"]')).toHaveValue('3');
});

Then('a species recorded as a free-text request is marked as requested', async ({ page }) => {
  await expect(appliedChip(page, 'Coyote')).toContainText('requested');
});

Then('several species collapse to a summary that can be expanded', async ({ page }) => {
  await page.getByRole('button', { name: 'Collapse applied species' }).click();
  const summary = page.locator('[data-testid="applied-species-summary"]');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('+1 more');
  // The entire summary row is the click target — not just the arrow glyph.
  await summary.click();
  await expect(appliedChip(page, 'Coyote')).toBeVisible();
});

// --- Corrections ------------------------------------------------------------

Given('the focused image records a species with a count', async ({ page }) => {
  await focusFrame(page, 'IMG001.JPG');
  await expect(appliedChip(page, 'Mule Deer').locator('input[type="number"]')).toHaveValue('2');
});

When('the count is changed', async ({ page }) => {
  await appliedChip(page, 'Mule Deer').locator('input[type="number"]').fill('5');
});

Then('the new count is held against that species for that image', async ({ page }) => {
  await expect(appliedChip(page, 'Mule Deer').locator('input[type="number"]')).toHaveValue('5');
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer ×5');
  await expect
    .poll(async () => {
      const rows = (await readStore(page, 'drafts')) as {
        mediaPath: string;
        observations: { scientificName: string; count: number }[];
      }[];
      const row = rows.find((r) => r.mediaPath.endsWith('IMG001.JPG'));
      return row?.observations.find((o) => o.scientificName === 'Odocoileus hemionus')?.count;
    })
    .toBe(5);
});

Then('a count below one is not accepted', async ({ page }) => {
  const input = appliedChip(page, 'Mule Deer').locator('input[type="number"]');
  await expect(input).toHaveAttribute('min', '1');
  await input.fill('0');
  await expect(input).toHaveValue('1');
  await expect(gridCell(page, 'IMG001.JPG')).not.toContainText('×0');
});

Given('the focused image carries several species', async ({ page }) => {
  await focusFrame(page, 'IMG004.JPG');
  await expandApplied(page);
  await expect(appliedChip(page, 'Mountain Lion')).toBeVisible();
  await expect(appliedChip(page, 'Coyote')).toBeVisible();
});

When('one of them is removed', async ({ page }) => {
  await page.getByRole('button', { name: 'Remove Coyote' }).click();
});

Then('only that species is dropped', async ({ page }) => {
  await expect(appliedChip(page, 'Coyote')).toHaveCount(0);
  await expect.poll(async () => draftSpecies(page, 'IMG004.JPG')).toEqual(['Puma concolor']);
});

Then('the remaining species and their counts are preserved', async ({ page }) => {
  await expect(appliedChip(page, 'Mountain Lion').locator('input[type="number"]')).toHaveValue('1');
  await expect(gridCell(page, 'IMG004.JPG')).toContainText('Mountain Lion');
  await expect(gridCell(page, 'IMG004.JPG')).not.toContainText('+1');
});

// --- Detag ------------------------------------------------------------------

Given('the focused image carries at least one species', async ({ page }) => {
  await focusFrame(page, 'IMG001.JPG');
  await enterFocusView(page);
  await expect(page.getByRole('button', { name: 'Detag', exact: true })).toBeEnabled();
});

When('{string} is used', async ({ page }, label: string) => {
  await page.getByRole('button', { name: label, exact: true }).click();
});

Then('the image is left with no species', async ({ page }) => {
  await expect.poll(async () => draftSpecies(page, 'IMG001.JPG')).toEqual([]);
});

Then('it reads as untagged again', async ({ page }) => {
  await expect(listRow(page, 'IMG001.JPG')).toContainText('untagged');
});

Then('the Detag control is unavailable on an image that has none', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Detag', exact: true })).toBeDisabled();
  await listRow(page, 'IMG004.JPG').click();
  await expect(page.getByRole('button', { name: 'Detag', exact: true })).toBeEnabled();
});

When('identifications are cleared', async ({ page }) => {
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.getByRole('button', { name: 'Detag', exact: true }).click();
});

Then('every selected image is left with no species', async ({ page }) => {
  for (const f of ['IMG001.JPG', 'IMG002.JPG', 'IMG003.JPG']) {
    await expect.poll(async () => draftSpecies(page, f)).toEqual([]);
  }
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(gridCell(page, 'IMG001.JPG')).not.toContainText('Mule Deer');
  await expect(gridCell(page, 'IMG003.JPG')).not.toContainText('Ghost');
});

// --- Questionable -----------------------------------------------------------

When('it is marked questionable', async ({ page }) => {
  await page.keyboard.press('Shift+Space');
});

Then("the image's tile carries a questionable marker", async ({ page }) => {
  await expect(gridCell(page, 'IMG002.JPG').locator('[title="questionable"]')).toBeVisible();
});

Then('the marker can be toggled off again', async ({ page }) => {
  await page.keyboard.press('Shift+Space');
  await expect(gridCell(page, 'IMG002.JPG').locator('[title="questionable"]')).toHaveCount(0);
});

Then('a selection of images can be marked in one action', async ({ page }) => {
  await gridCell(page, 'IMG001.JPG').click();
  await gridCell(page, 'IMG003.JPG').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Shift+Space');
  for (const f of ['IMG001.JPG', 'IMG002.JPG', 'IMG003.JPG']) {
    await expect(gridCell(page, f).locator('[title="questionable"]')).toBeVisible();
  }
});

// --- Confirmation records nothing -------------------------------------------

Given('an existing identification is re-applied unchanged', async ({ page }) => {
  await focusFrame(page, 'IMG001.JPG');
  await speciesApply(page, 'Odocoileus hemionus').click();
});

When('a sync is previewed', async ({ page }) => {
  await openSyncDialog(page);
});

Then('no change is reported for that image', async ({ page, s3 }) => {
  await expect(
    page.getByText('No local edits to sync — everything matches the canonical files.'),
  ).toBeVisible();
  expect(s3.puts).toHaveLength(0);
});

// --- Attribution ------------------------------------------------------------

Given('identifications were corrected locally', async ({ page }) => {
  await sectionTab(page, 'Settings').click();
  await page.locator('#user').fill('jgonzalez');
  await sectionTab(page, 'Tag').click();
  await focusFrame(page, 'IMG002.JPG');
  await speciesApply(page, 'Canis latrans').click();
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Coyote');
});

When('a live sync is run', async ({ page }) => {
  await openSyncDialog(page);
  await setSyncDryRun(page, false);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Synced — canonical files replaced.')).toBeVisible();
});

Then(
  'the upload\'s metadata gains an edit comment carrying the tagger identity and the time of the edit',
  async ({ s3 }) => {
    const meta = JSON.parse(s3.text(BUCKET, `${PREFIX_A}UploadMeta.json`)) as {
      editComments: string[];
    };
    const last = meta.editComments[meta.editComments.length - 1];
    expect(last).toContain('jgonzalez');
    expect(last).toMatch(/\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.\d{2}/);
  },
);

Then('the pre-change snapshot of the upload is filed under that same identity', async ({ s3 }) => {
  const snapshots = s3.puts.filter((p) => p.key.includes('.sparcd-tagger-snapshots/'));
  expect(snapshots.length).toBeGreaterThan(0);
  for (const p of snapshots) expect(p.key).toContain('.sparcd-tagger-snapshots/jgonzalez/');
  expect(snapshots.some((p) => p.key.endsWith('manifest.json'))).toBe(true);
});

// --- Unsaved-edit marker ----------------------------------------------------

Given("an image's identifications were changed in this browser", async ({ page }) => {
  await focusFrame(page, 'IMG002.JPG');
  await speciesApply(page, 'Canis latrans').click();
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Coyote');
});

Then('its tile carries an unsaved-edit marker', async ({ page }) => {
  await expect(gridCell(page, 'IMG002.JPG').locator('[title="unsaved edit"]')).toBeVisible();
  await expect(gridCell(page, 'IMG005.JPG').locator('[title="unsaved edit"]')).toHaveCount(0);
});

Then('the marker is cleared for that image once its change has been synced', async ({ page }) => {
  await sectionTab(page, 'Settings').click();
  await page.locator('#user').fill('jgonzalez');
  await sectionTab(page, 'Tag').click();
  await openSyncDialog(page);
  await setSyncDryRun(page, false);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Synced — canonical files replaced.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(gridCell(page, 'IMG002.JPG').locator('[title="unsaved edit"]')).toHaveCount(0);
});

// --- Blank-row uploads (issue #89) ------------------------------------------

Given('an upload with only uploader-written blank rows is open in the tagging workspace', async ({ page }) => {
  // Navigate to Browse explicitly — the H3 background may have already opened
  // a different workspace, and openAppConnected skips reconnection in that state,
  // leaving selectCollection unable to surface the upload list heading.
  await sectionTab(page, 'Browse').click();
  await selectCollection(page);
  await openUpload(page, 'newuploader');
  await expect(gridCell(page, 'IMG001.JPG')).not.toContainText('Deer');
  await expect(gridCell(page, 'IMG001.JPG')).not.toContainText('Coyote');
});

Then('every image tile is shown as untagged', async ({ page }) => {
  for (const m of MEDIA_A.filter((m) => !m.file.endsWith('.MP4'))) {
    // A tile with no species shows only its filename — "untagged" is list-view only.
    // The key assertion is that no species name bleeds through from the blank row.
    await expect(gridCell(page, m.file)).not.toContainText('×');
  }
});

Then('the list view labels every image "untagged"', async ({ page }) => {
  await page.getByRole('button', { name: '☰ List' }).click();
  for (const m of MEDIA_A) {
    await expect(listRow(page, m.file)).toContainText('untagged');
  }
});

When('the Sync dialog is opened for a blank-row upload', async ({ page }) => {
  await openSyncDialog(page);
});

Then('the sync reports there is nothing to sync', async ({ page }) => {
  await expect(
    page.getByText('No local edits to sync — everything matches the canonical files.'),
  ).toBeVisible();
});
