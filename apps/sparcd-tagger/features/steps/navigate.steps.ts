import type { Page } from '@playwright/test';
import {
  Given,
  When,
  Then,
  expect,
  gridCell,
  listRow,
  tileOrder,
  focusedTile,
  selectedTiles,
  positionReadout,
  speciesFilter,
  imageSearch,
  speciesRow,
  focusFrame,
} from './support/world';

const TOUCH = { width: 900, height: 860 };
const DESKTOP = { width: 1440, height: 950 };

const focusedName = async (page: Page): Promise<string> =>
  (await focusedTile(page).first().getAttribute('title')) ?? '';

// --- Views ------------------------------------------------------------------

Then('the Overview can be switched between a grid of tiles and a list of rows', async ({ page }) => {
  await expect(gridCell(page, 'IMG001.JPG')).toBeVisible();
  await page.getByRole('button', { name: '☰ List' }).click();
  await expect(listRow(page, 'IMG001.JPG')).toBeVisible();
  await expect(gridCell(page, 'IMG001.JPG')).toHaveCount(0);
  await page.getByRole('button', { name: '▦ Grid' }).click();
  await expect(gridCell(page, 'IMG001.JPG')).toBeVisible();
});

Then('the workspace shows the position of the focused image within the upload', async ({ page }) => {
  await expect(positionReadout(page)).toHaveText('1 / 6');
  await gridCell(page, 'IMG003.JPG').click();
  await expect(positionReadout(page)).toHaveText('3 / 6');
});

Then('the Focus view keeps the list alongside the enlarged image', async ({ page }) => {
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('.react-transform-component img')).toBeVisible();
  await expect(listRow(page, 'IMG001.JPG')).toBeVisible();
  await expect(listRow(page, 'IMG005.JPG')).toBeVisible();
});

// --- Keyboard navigation ----------------------------------------------------

When('the next-image or previous-image key is pressed', async ({ page }) => {
  await page.keyboard.press('ArrowDown');
});

Then('focus moves one image in that direction', async ({ page }) => {
  await expect(positionReadout(page)).toHaveText('2 / 6');
  await page.keyboard.press('ArrowUp');
  await expect(positionReadout(page)).toHaveText('1 / 6');
});

Then('it stops at the first and last image of the upload', async ({ page }) => {
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(positionReadout(page)).toHaveText('1 / 6');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  await expect(positionReadout(page)).toHaveText('6 / 6');
});

Then('any selection is cleared by the move', async ({ page }) => {
  await gridCell(page, 'IMG001.JPG').click();
  await gridCell(page, 'IMG003.JPG').click({ modifiers: ['Shift'] });
  await expect(positionReadout(page)).toHaveText('3 selected');
  await page.keyboard.press('ArrowDown');
  await expect(positionReadout(page)).toHaveText('4 / 6');
  await expect(selectedTiles(page)).toHaveCount(0);
});

Given('the Overview is shown', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

When('the focused image is opened', async ({ page }) => {
  await gridCell(page, 'IMG003.JPG').click();
  await page.keyboard.press('Enter');
});

Then('the Focus view shows that image', async ({ page }) => {
  await expect(page.locator('.react-transform-component img')).toHaveAttribute(
    'alt',
    'IMG003.JPG',
  );
});

Then('on-screen previous and next controls move between images there', async ({ page }) => {
  // The paging buttons are the touch affordance, shown below the lg breakpoint.
  await page.setViewportSize(TOUCH);
  const previous = page.getByRole('button', { name: 'Previous image' });
  const next = page.getByRole('button', { name: 'Next image' });
  const questionable = page.getByRole('button', { name: 'Questionable' });
  await expect(previous).toHaveAttribute('title', 'Previous image (Arrow Up)');
  await expect(next).toHaveAttribute('title', 'Next image (Arrow Down)');
  await expect(questionable).toHaveAttribute('title', 'Toggle questionable (Shift+Space)');
  for (const retired of [
    'Previous image (k)',
    'Next image (j)',
    'Toggle questionable (x)',
  ]) {
    await expect(page.locator(`[title="${retired}"]`)).toHaveCount(0);
  }
  await next.click();
  await expect(positionReadout(page)).toHaveText('4 / 6');
  await previous.click();
  await expect(positionReadout(page)).toHaveText('3 / 6');
  await page.setViewportSize(DESKTOP);
});

// --- Sorting ----------------------------------------------------------------

When('a sort field is chosen', async ({ page }) => {
  await page.getByRole('button', { name: /^Date/ }).click();
});

Then('the images are ordered by that field', async ({ page }) => {
  // Ascending by capture time; the clip has none, so it sorts first.
  await expect.poll(async () => (await tileOrder(page))[0]).toBe('VID001.MP4');
  expect((await tileOrder(page)).slice(1)).toEqual([
    'IMG001.JPG',
    'IMG002.JPG',
    'IMG003.JPG',
    'IMG004.JPG',
    'IMG005.JPG',
  ]);
});

Then('choosing the same field again reverses the order', async ({ page }) => {
  await page.getByRole('button', { name: /^Date/ }).click();
  await expect.poll(async () => (await tileOrder(page))[0]).toBe('IMG005.JPG');
});

Then('images that tie keep their original file order', async ({ page }) => {
  await page.getByRole('button', { name: /^Type/ }).click();
  const order = await tileOrder(page);
  expect(order.slice(0, 5)).toEqual([
    'IMG001.JPG',
    'IMG002.JPG',
    'IMG003.JPG',
    'IMG004.JPG',
    'IMG005.JPG',
  ]);
  expect(order[5]).toBe('VID001.MP4');
});

Given('some images are selected and one is focused', async ({ page, scratch }) => {
  await gridCell(page, 'IMG002.JPG').click();
  await gridCell(page, 'IMG004.JPG').click({ modifiers: ['Shift'] });
  await expect(positionReadout(page)).toHaveText('3 selected');
  scratch.selectedBefore = await selectedTiles(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  );
  scratch.focusedBefore = await focusedName(page);
});

When('the sort order is changed', async ({ page }) => {
  await page.getByRole('button', { name: /^Date/ }).click();
  await expect.poll(async () => (await tileOrder(page))[0]).toBe('VID001.MP4');
});

Then('the same images remain selected', async ({ page, scratch }) => {
  // The re-map runs in an effect after the re-ordered strip commits, so poll.
  await expect
    .poll(async () =>
      (
        await selectedTiles(page).evaluateAll((els) =>
          els.map((e) => e.getAttribute('title') ?? ''),
        )
      )
        .slice()
        .sort(),
    )
    .toEqual((scratch.selectedBefore as string[]).slice().sort());
  const after = await selectedTiles(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  );
  expect(after.length).toBe((scratch.selectedBefore as string[]).length);
});

Then('the same image remains focused, at its new position', async ({ page, scratch }) => {
  await expect.poll(async () => focusedName(page)).toBe(scratch.focusedBefore as string);
  // IMG004 sits fifth once the untimed clip sorts to the front.
  await expect(positionReadout(page)).toHaveText('3 selected');
  await page.keyboard.press('Escape');
  await expect(positionReadout(page)).toHaveText('5 / 6');
});

// --- Find by file name ------------------------------------------------------

When('part of a file name is typed into the image search', async ({ page }) => {
  await imageSearch(page).fill('IMG00');
});

Then('focus jumps to the first matching image', async ({ page }) => {
  await expect.poll(async () => focusedName(page)).toBe('IMG001.JPG');
});

Then('the number of matches and the current match position are shown', async ({ page }) => {
  await expect(page.getByText('1/5')).toBeVisible();
});

Then('the matches can be cycled forwards and backwards', async ({ page }) => {
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(page.getByText('2/5')).toBeVisible();
  await expect.poll(async () => focusedName(page)).toBe('IMG002.JPG');
  await page.getByRole('button', { name: 'Previous match' }).click();
  await expect(page.getByText('1/5')).toBeVisible();
  await expect.poll(async () => focusedName(page)).toBe('IMG001.JPG');
});

Then("clearing the search leaves the upload's order untouched", async ({ page }) => {
  const before = await tileOrder(page);
  await page.getByRole('button', { name: 'Clear image search' }).click();
  await expect(imageSearch(page)).toHaveValue('');
  expect(await tileOrder(page)).toEqual(before);
});

// --- Mouse selection --------------------------------------------------------

When('an image is clicked', async ({ page }) => {
  await gridCell(page, 'IMG002.JPG').click();
});

Then('only that image is selected as the focus', async ({ page }) => {
  await expect(focusedTile(page)).toHaveAttribute('title', 'IMG002.JPG');
  await expect(selectedTiles(page)).toHaveCount(0);
  await expect(positionReadout(page)).toHaveText('2 / 6');
});

Then('shift-clicking another image selects the whole range between them', async ({ page }) => {
  await gridCell(page, 'IMG004.JPG').click({ modifiers: ['Shift'] });
  await expect(positionReadout(page)).toHaveText('3 selected');
  const titles = await selectedTiles(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  );
  expect(titles.sort()).toEqual(['IMG002.JPG', 'IMG003.JPG', 'IMG004.JPG']);
});

Then(
  'command- or control-clicking adds or removes a single image from the selection',
  async ({ page }) => {
    await gridCell(page, 'IMG001.JPG').click({ modifiers: ['ControlOrMeta'] });
    await expect(positionReadout(page)).toHaveText('4 selected');
    await gridCell(page, 'IMG001.JPG').click({ modifiers: ['ControlOrMeta'] });
    await expect(positionReadout(page)).toHaveText('3 selected');
  },
);

Then(
  'a selected count is shown in place of the position when a selection exists',
  async ({ page }) => {
    await gridCell(page, 'IMG001.JPG').click();
    await expect(positionReadout(page)).toHaveText('1 / 6');
    await gridCell(page, 'IMG002.JPG').click({ modifiers: ['Shift'] });
    await expect(positionReadout(page)).toHaveText('2 selected');
  },
);

Then('pressing Escape clears the selection', async ({ page }) => {
  await page.keyboard.press('Escape');
  await expect(positionReadout(page)).toHaveText('2 / 6');
  await expect(selectedTiles(page)).toHaveCount(0);
});

Then(
  'an on-screen control adds or removes the focused image from the selection on touch',
  async ({ page }) => {
    await page.setViewportSize(TOUCH);
    const toggle = page.locator(
      'button[title="Add or remove this image from the selection"]',
    );
    await toggle.click();
    await expect(positionReadout(page)).toHaveText('1 selected');
    await expect(toggle).toContainText('In selection');
    await toggle.click();
    await expect(positionReadout(page)).toHaveText('2 / 6');
    await page.setViewportSize(DESKTOP);
  },
);

// --- Bursts -----------------------------------------------------------------

Then(
  'images from the same camera taken within the configured window are banded together',
  async ({ page }) => {
    await expect(page.getByText(/^Burst 1 ·/)).toContainText('2 img');
    await expect(page.locator('div').filter({ hasText: /^Burst \d+ ·/ })).not.toHaveCount(0);
  },
);

Then('each band states how many images it holds and the time it spans', async ({ page }) => {
  await expect(page.getByText(/^Burst 1 ·/)).toHaveText('Burst 1 · 2 img · 08:00:00–08:00:30');
  await expect(page.getByText(/^Burst 2 ·/)).toHaveText('Burst 2 · 1 img · 22:15:00');
});

Then('the whole band can be selected in one action', async ({ page }) => {
  await page
    .locator('div')
    .filter({ hasText: /^Burst 1 · / })
    .last()
    .getByRole('button', { name: 'select' })
    .click();
  await expect(positionReadout(page)).toHaveText('2 selected');
});

Then('the burst-forward and burst-back keys jump between bands', async ({ page }) => {
  await page.keyboard.press('Escape');
  await gridCell(page, 'IMG001.JPG').click();
  await page.keyboard.press('PageDown');
  await expect(positionReadout(page)).toHaveText('3 / 6');
  await page.keyboard.press('PageDown');
  await expect(positionReadout(page)).toHaveText('4 / 6');
  await page.keyboard.press('PageUp');
  await expect(positionReadout(page)).toHaveText('3 / 6');
});

Given('an image has no capture time', async ({ page }) => {
  // Bands only exist with grouping on, which is off by default.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page
    .locator('label')
    .filter({ hasText: 'Group rapid sequences into bursts' })
    .locator('input[type="checkbox"]')
    .check();
  await page.getByRole('button', { name: 'Tag', exact: true }).first().click();
  await expect(page.getByText(/^Burst 1 ·/)).toBeVisible();
  await expect(gridCell(page, 'VID001.MP4')).toBeVisible();
});

Then('it starts a new burst rather than joining the previous one', async ({ page }) => {
  await expect(page.getByText(/^Burst 4 ·/)).toHaveText('Burst 4 · 1 img · —');
  await expect(page.getByText(/^Burst 3 ·/)).toContainText('2 img');
  await expect(page.getByText(/^Burst 5 ·/)).toHaveCount(0);
});

// --- Cheatsheet -------------------------------------------------------------

const cheatsheet = (page: Page) =>
  page.locator('div[role="dialog"][aria-label="Keyboard shortcuts"]');

When('the help key is pressed or the on-screen help control is used', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(cheatsheet(page)).toBeVisible();
});

Then('the shortcut reference is shown, grouped by navigating, tagging and selecting', async ({
  page,
}) => {
  await expect(cheatsheet(page).getByRole('heading', { name: 'Navigate' })).toBeVisible();
  await expect(cheatsheet(page).getByRole('heading', { name: 'Tag', exact: true })).toBeVisible();
  await expect(cheatsheet(page).getByRole('heading', { name: 'Select & save' })).toBeVisible();
  for (const key of ['↓', '↑', 'PgDn', 'PgUp', '⇧Space']) {
    await expect(cheatsheet(page).getByText(key, { exact: true })).toBeVisible();
  }
  for (const retired of ['J', 'K', '⇧J', '⇧K', 'X']) {
    await expect(cheatsheet(page).getByText(retired, { exact: true })).toHaveCount(0);
  }
});

Then(
  'it can be dismissed with the same key, with Escape, or with its close control',
  async ({ page }) => {
    await page.keyboard.press('?');
    await expect(cheatsheet(page)).toHaveCount(0);

    await page.keyboard.press('?');
    await expect(cheatsheet(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cheatsheet(page)).toHaveCount(0);

    await page.keyboard.press('?');
    await cheatsheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(cheatsheet(page)).toHaveCount(0);
  },
);

Then('no tagging or navigation keystroke takes effect while it is open', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(cheatsheet(page)).toBeVisible();
  const position = await positionReadout(page).textContent();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('d');
  await expect(positionReadout(page)).toHaveText(position!);
  await expect(page.getByText(/unsaved · discard/)).toHaveCount(0);
  await page.keyboard.press('Escape');
});

// --- Typing suppresses accelerators -----------------------------------------

Given('the cursor is in a text field', async ({ page }) => {
  await speciesFilter(page).click();
  await expect(speciesFilter(page)).toBeFocused();
});

Then('letter keys type into that field rather than applying species', async ({ page }) => {
  await page.keyboard.type('dg');
  await expect(speciesFilter(page)).toHaveValue('dg');
  await expect(page.getByText(/unsaved · discard/)).toHaveCount(0);
  await speciesFilter(page).fill('');
});

Then(
  'pressing Enter in the species filter applies the top match and leaves the field',
  async ({ page }) => {
    await speciesFilter(page).fill('coyote');
    await page.keyboard.press('Enter');
    await expect(speciesFilter(page)).not.toBeFocused();
    // IMG001 already carried Mule Deer, so Coyote lands as the extra species.
    await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer ×2 +1');
    await expect(
      speciesRow(page, 'Canis latrans').locator('[aria-label="Applied"]'),
    ).toBeVisible();
  },
);

Then(
  'pressing Enter in the image search moves to the next match instead of tagging',
  async ({ page }) => {
    await imageSearch(page).fill('IMG00');
    await expect(page.getByText('1/5')).toBeVisible();
    const dirtyBefore = await page.getByText(/unsaved · discard/).textContent();
    await imageSearch(page).press('Enter');
    await expect(page.getByText('2/5')).toBeVisible();
    await expect(page.getByText(/unsaved · discard/)).toHaveText(dirtyBefore!);
  },
);

// --- Media / dialogs own the keyboard ---------------------------------------

Given('a video is being played or scrubbed', async ({ page }) => {
  await focusFrame(page, 'VID001.MP4');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('video[controls]')).toBeVisible();
  await page.locator('video[controls]').focus();
});

Then('its own playback keys work and no tagging keystroke fires', async ({ page }) => {
  await page.keyboard.press('d');
  await page.keyboard.press(' ');
  await expect(speciesFilter(page)).not.toBeFocused();
  await expect(page.getByText(/unsaved · discard/)).toHaveCount(0);
  await expect(listRow(page, 'VID001.MP4')).toContainText('untagged');
});

Then(
  'while the sync, snapshots or time-shift dialog is open no image behind it is tagged or navigated',
  async ({ page }) => {
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await focusFrame(page, 'IMG002.JPG');
    const position = await positionReadout(page).textContent();

    for (const [open, close] of [
      ['Sync…', 'Cancel'],
      ['Snapshots…', 'Close'],
      ['Time shift', 'Cancel'],
    ] as const) {
      await page.getByRole('button', { name: open }).click();
      await page.keyboard.press('d');
      await page.keyboard.press('ArrowDown');
      await expect(page.getByText(/unsaved · discard/)).toHaveCount(0);
      await expect(positionReadout(page)).toHaveText(position!);
      await page.getByRole('button', { name: close, exact: true }).first().click();
      await expect(page.getByRole('button', { name: close, exact: true })).toHaveCount(0);
    }
    await expect(gridCell(page, 'IMG002.JPG')).not.toContainText('Mule Deer');
  },
);
