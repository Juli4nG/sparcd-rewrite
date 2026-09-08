import type { Page } from '@playwright/test';
import {
  Given,
  When,
  Then,
  expect,
  connect,
  selectCollection,
  openUpload,
  enterFocusView,
  focusFrame,
  gridCell,
  speciesRow,
  speciesTile,
  speciesApply,
  speciesFilter,
  speciesLoupeButton,
  speciesAssignKey,
  speciesClearKey,
  speciesBadge,
  ghostRow,
  positionReadout,
} from './support/world';
import { BUCKET, PREFIX_A, observationsCsv, OBS_A } from './support/data';
import { readStore, waitForDirtyDrafts } from './support/flows';

const VOCAB = [
  { common: 'Coyote', scientific: 'Canis latrans' },
  { common: 'Javelina', scientific: 'Pecari tajacu' },
  { common: 'Mountain Lion', scientific: 'Puma concolor' },
  { common: 'Mule Deer', scientific: 'Odocoileus hemionus' },
];

const appliedChip = (page: Page, label: string) =>
  page.locator('span.inline-flex:not([data-testid="applied-species-summary"])').filter({ hasText: label }).first();

/** Two or more species collapse to a summary; open it so the chips render. */
async function expandApplied(page: Page): Promise<void> {
  const summary = page.locator('button[title="Show all applied species"]');
  if (await summary.count()) await summary.click();
}

/** The effective observations the store holds for one media file. */
async function draftSpecies(page: Page, fileName: string): Promise<string[]> {
  const rows = (await readStore(page, 'drafts')) as {
    mediaPath: string;
    observations: { scientificName: string }[];
  }[];
  const row = rows.find((r) => r.mediaPath.endsWith(fileName));
  return (row?.observations ?? []).map((o) => o.scientificName);
}

Given('the species vocabulary has loaded', async ({ page }) => {
  for (const s of VOCAB) await expect(speciesRow(page, s.scientific)).toBeVisible();
});

// --- Browsable list ---------------------------------------------------------

Then(
  'every species in the vocabulary is listed with its common and scientific name',
  async ({ page }) => {
    for (const s of VOCAB) {
      const row = speciesRow(page, s.scientific);
      await expect(row).toContainText(s.common);
      await expect(row).toContainText(s.scientific);
    }
  },
);

Then('the species list is headed "Available species"', async ({ page }) => {
  await expect(page.getByText('Available species', { exact: true })).toBeVisible();
});

Then('each species shows its reference image where one exists', async ({ page }) => {
  for (const s of VOCAB) {
    await expect(speciesRow(page, s.scientific).locator('img')).toHaveAttribute(
      'src',
      /example\.org/,
    );
  }
});

Then('each species shows the key bound to it, when it has one', async ({ page }) => {
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('D');
  await expect(speciesBadge(page, 'Puma concolor')).toHaveText('P');
  await expect(speciesBadge(page, 'Canis latrans')).toHaveCount(0);
  await expect(ghostRow(page).locator('kbd')).toHaveText('G');
});

Then('Ghost appears exactly once as a species from the vocabulary', async ({ page }) => {
  const rows = page.locator('div.group').filter({ has: page.getByText('Ghost', { exact: true }) });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Casper');
  await expect(rows.locator('kbd')).toHaveText('G');
});

// --- Applying ---------------------------------------------------------------

When('a species tile is selected', async ({ page }) => {
  await speciesTile(page, 'Canis latrans').click();
});

Then('that species tile remains highlighted', async ({ page }) => {
  await expect(speciesTile(page, 'Canis latrans')).toHaveAttribute('aria-pressed', 'true');
  await expect(speciesRow(page, 'Canis latrans')).toHaveClass(/ring-accent/);
});

Then('selecting the species has not changed the focused image', async ({ page }) => {
  await expect(appliedChip(page, 'Coyote')).toHaveCount(0);
  const drafts = (await readStore(page, 'drafts')) as {
    observations: { scientificName: string }[];
  }[];
  expect(
    drafts.some((d) => d.observations.some((o) => o.scientificName === 'Canis latrans')),
  ).toBe(false);
  await expect(page.getByText(/unsaved · discard/)).toHaveCount(0);
});

Then('that species is recorded on the focused image with a count of one', async ({ page }) => {
  await expect(appliedChip(page, 'Coyote')).toBeVisible();
  await expect(appliedChip(page, 'Coyote').locator('input[type="number"]')).toHaveValue('1');
});

Then('the image\'s tile shows the species instead of "untagged"', async ({ page }) => {
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Coyote');
  await expect(gridCell(page, 'IMG002.JPG')).not.toContainText('untagged');
});

Given('the focused image already carries one species', async ({ page }) => {
  await focusFrame(page, 'IMG001.JPG');
  await expect(appliedChip(page, 'Mule Deer')).toBeVisible();
});

When('a second species is applied to it', async ({ page }) => {
  await speciesApply(page, 'Canis latrans').click();
});

Then('both species are recorded on that image', async ({ page }) => {
  await expandApplied(page);
  await expect(appliedChip(page, 'Mule Deer')).toBeVisible();
  await expect(appliedChip(page, 'Coyote')).toBeVisible();
});

Then('neither replaces the other', async ({ page }) => {
  await expect(appliedChip(page, 'Mule Deer').locator('input[type="number"]')).toHaveValue('2');
  await expect(appliedChip(page, 'Coyote').locator('input[type="number"]')).toHaveValue('1');
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer ×2 +1');
});

Given('the focused image already carries a species', async ({ page }) => {
  await focusFrame(page, 'IMG001.JPG');
  await expect(appliedChip(page, 'Mule Deer')).toBeVisible();
});

Then("that species' row is marked as applied", async ({ page }) => {
  await expect(speciesRow(page, 'Odocoileus hemionus').locator('[aria-label="Applied"]')).toBeVisible();
});

Then('using it again neither duplicates the species nor changes its count', async ({ page }) => {
  await speciesApply(page, 'Odocoileus hemionus').click();
  await expect(appliedChip(page, 'Mule Deer')).toHaveCount(1);
  await expect(appliedChip(page, 'Mule Deer').locator('input[type="number"]')).toHaveValue('2');
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer ×2');
});

// --- Bulk apply -------------------------------------------------------------

Then(
  'the species panel states how many images an identification will apply to',
  async ({ page }) => {
    await expect(page.getByText('Applying to 3 selected images')).toBeVisible();
  },
);

Then('applying a species records it on every selected image', async ({ page }) => {
  await speciesApply(page, 'Pecari tajacu').click();
  // The untagged frame now reads as Javelina; the already-tagged ones keep
  // their species and gain it as an extra ("+1" on the tile summary).
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Javelina');
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Mule Deer ×2 +1');
  await expect(gridCell(page, 'IMG003.JPG')).toContainText('Javelina');
  for (const f of ['IMG001.JPG', 'IMG002.JPG', 'IMG003.JPG']) {
    await expect.poll(async () => await draftSpecies(page, f)).toContain('Pecari tajacu');
  }
});

// --- Ghost ------------------------------------------------------------------

When('the Ghost label is applied to an image', async ({ page }) => {
  await focusFrame(page, 'IMG001.JPG');
  await expect(appliedChip(page, 'Mule Deer')).toBeVisible();
  await ghostRow(page)
    .locator('button[title^="Apply"], button[title$="already applied"]')
    .click();
});

Then('the image is recorded as an empty or false-trigger frame', async ({ page }) => {
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Ghost');
  await expect(ghostRow(page)).toContainText('Casper');
});

Then('any real species previously on that image is removed', async ({ page }) => {
  await expect(appliedChip(page, 'Mule Deer')).toHaveCount(0);
  await expect(gridCell(page, 'IMG001.JPG')).not.toContainText('Mule Deer');
});

Then('applying a real species afterwards removes the Ghost label', async ({ page }) => {
  await speciesApply(page, 'Canis latrans').click();
  await expect(gridCell(page, 'IMG001.JPG')).toContainText('Coyote');
  await expect(gridCell(page, 'IMG001.JPG')).not.toContainText('Ghost');
});

// --- Filtering --------------------------------------------------------------

When('text is typed into the species filter', async ({ page }) => {
  await speciesFilter(page).fill('coyote');
});

Then(
  'the list narrows to species matching that text by common or scientific name',
  async ({ page }) => {
    await expect(speciesRow(page, 'Canis latrans')).toBeVisible();
    await expect(speciesRow(page, 'Odocoileus hemionus')).toHaveCount(0);
    await speciesFilter(page).fill('Pecari');
    await expect(speciesRow(page, 'Pecari tajacu')).toBeVisible();
    await expect(speciesRow(page, 'Canis latrans')).toHaveCount(0);
  },
);

Then('close-but-inexact spellings still match', async ({ page }) => {
  await speciesFilter(page).fill('coyot');
  await expect(speciesRow(page, 'Canis latrans')).toBeVisible();
  await speciesFilter(page).fill('mulederr');
  await expect(speciesRow(page, 'Odocoileus hemionus')).toBeVisible();
});

Given('filter text matches no species exactly', async ({ page }) => {
  await speciesFilter(page).fill('Ringtail');
  await expect(page.getByText('Tag as requested species')).toBeVisible();
});

Then('the panel offers to record the typed name as a requested species', async ({ page }) => {
  await expect(page.getByText('Tag as requested species')).toBeVisible();
  await expect(page.getByText(/Ringtail.*REQUESTED_SPECIES/)).toBeVisible();
});

Then(
  'applying it records that free text against the image alongside the identification',
  async ({ page }) => {
    await speciesRow(page, 'REQUESTED_SPECIES')
      .locator('button[title^="Apply"], button[title$="already applied"]')
      .click();
    await expandApplied(page);
    const chip = appliedChip(page, 'Ringtail');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('requested');
    const drafts = (await readStore(page, 'drafts')) as {
      observations: { scientificName: string; requestedSpecies: string }[];
    }[];
    await expect
      .poll(async () => {
        const rows = (await readStore(page, 'drafts')) as {
          observations: { scientificName: string; requestedSpecies: string }[];
        }[];
        return rows.some((d) =>
          d.observations.some(
            (o) => o.scientificName === 'Ringtail' && o.requestedSpecies === 'Ringtail',
          ),
        );
      })
      .toBe(true);
    expect(Array.isArray(drafts)).toBe(true);
  },
);

// --- Recents ----------------------------------------------------------------

Given('several species have been applied during this session', async ({ page }) => {
  await focusFrame(page, 'IMG002.JPG');
  await speciesApply(page, 'Odocoileus hemionus').click();
  await focusFrame(page, 'IMG005.JPG');
  await speciesApply(page, 'Pecari tajacu').click();
});

Then('those species are listed first, most recently used first', async ({ page }) => {
  const names = await page.locator('div.group span.italic').allTextContents();
  const vocabOrder = names.filter((n) => VOCAB.some((v) => v.scientific === n));
  expect(vocabOrder.slice(0, 2)).toEqual(['Pecari tajacu', 'Odocoileus hemionus']);
});

Then('their key bindings are unchanged by that reordering', async ({ page }) => {
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('D');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveCount(0);
});

// --- Key bindings -----------------------------------------------------------

Given('a species row is shown', async ({ page }) => {
  await expect(speciesRow(page, 'Pecari tajacu')).toBeVisible();
});

When('a key is assigned to it and that key is pressed with an image focused', async ({ page }) => {
  await focusFrame(page, 'IMG002.JPG');
  await speciesAssignKey(page, 'Pecari tajacu').click();
  await expect(speciesRow(page, 'Pecari tajacu')).toContainText('press a key…');
  await page.keyboard.press('v');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveText('V');
  await page.keyboard.press('v');
});

Then('that species is recorded on the image', async ({ page }) => {
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Javelina');
});

Then('the assigned key is shown on the species row', async ({ page }) => {
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveText('V');
});

When('{string} is assigned to a species and pressed', async ({ page }, key: string) => {
  await speciesAssignKey(page, 'Pecari tajacu').click();
  await page.keyboard.press(key);
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveText(key.toUpperCase());
  await page.keyboard.press(key);
});

Then('the keyboard shortcut reference is not opened', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
});

When('an Alt-modified printable key is pressed while assigning a species key', async ({ page }) => {
  await speciesAssignKey(page, 'Pecari tajacu').click();
  await page.keyboard.press('Alt+j');
});

Then('key capture remains active and no key is assigned', async ({ page }) => {
  await expect(speciesRow(page, 'Pecari tajacu')).toContainText('press a key…');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveCount(0);
});

When('a Shift-produced symbol is assigned to the species', async ({ page }) => {
  await page.keyboard.press('Shift+Digit1');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveText('!');
});

When('that binding is pressed with Alt or Option', async ({ page }) => {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '!', altKey: true, bubbles: true }));
  });
});

Then('the species is not recorded on the image', async ({ page }) => {
  await expect(gridCell(page, 'IMG002.JPG')).not.toContainText('Javelina');
});

When('that binding is pressed without Alt or Option', async ({ page }) => {
  await page.keyboard.press('Shift+Digit1');
});

When('a lowercase alphabetic key is assigned to a species', async ({ page }) => {
  await speciesAssignKey(page, 'Pecari tajacu').click();
  await page.keyboard.press('v');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveText('V');
});

When('the uppercase form of that binding is pressed', async ({ page }) => {
  await page.keyboard.press('Shift+V');
});

When('the unassigned keyboard-help shortcut is pressed', async ({ page }) => {
  await page.keyboard.press('Shift+Slash');
});

Then('the keyboard shortcut reference is opened', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

Given('the species vocabulary carries a key binding for a species', async ({ page }) => {
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('D');
});

Then('that key applies the species without any local assignment', async ({ page }) => {
  await focusFrame(page, 'IMG002.JPG');
  await page.keyboard.press('d');
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Mule Deer');
});

Then('a locally assigned key replaces it for that species', async ({ page }) => {
  await speciesAssignKey(page, 'Odocoileus hemionus').click();
  await page.keyboard.press('m');
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('M');
  await focusFrame(page, 'IMG005.JPG');
  await page.keyboard.press('m');
  await expect(gridCell(page, 'IMG005.JPG')).toContainText('Mule Deer');
});

Given('a key is already assigned to one species', async ({ page }) => {
  await speciesAssignKey(page, 'Canis latrans').click();
  await page.keyboard.press('z');
  await expect(speciesBadge(page, 'Canis latrans')).toHaveText('Z');
});

When('the same key is assigned to a different species', async ({ page }) => {
  await speciesAssignKey(page, 'Pecari tajacu').click();
  await page.keyboard.press('z');
});

const keyConflictDialog = (page: Page) =>
  page.getByRole('alertdialog', { name: 'Key already assigned' });

Then(
  'an unmistakable duplicate-key warning identifies the existing assignment',
  async ({ page }) => {
    await expect(keyConflictDialog(page)).toBeVisible();
    await expect(keyConflictDialog(page)).toContainText(/already assigned to (Coyote|Mule Deer)/);
  },
);

Then('neither binding changes before reassignment is confirmed', async ({ page }) => {
  await expect(speciesBadge(page, 'Canis latrans')).toHaveText('Z');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveCount(0);
});

When('the duplicate key reassignment is confirmed', async ({ page }) => {
  await keyConflictDialog(page).getByRole('button', { name: 'Reassign key' }).click();
});

Then('the new species takes the key', async ({ page }) => {
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveText('Z');
  await focusFrame(page, 'IMG002.JPG');
  await page.keyboard.press('z');
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Javelina');
});

Then('the previous species is left without one', async ({ page }) => {
  await expect(speciesBadge(page, 'Canis latrans')).toHaveCount(0);
});

When('its key is assigned to a different species', async ({ page }) => {
  await speciesAssignKey(page, 'Pecari tajacu').click();
  await page.keyboard.press('d');
});

Then('keyboard focus remains inside the duplicate-key warning', async ({ page }) => {
  const dialog = keyConflictDialog(page);
  await expect(dialog.getByRole('button', { name: 'Reassign key' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Reassign key' })).toBeFocused();
});

When('the duplicate key warning is cancelled with Escape', async ({ page }) => {
  await page.keyboard.press('Escape');
  await expect(keyConflictDialog(page)).toHaveCount(0);
});

Then('the vocabulary key remains with its original species', async ({ page }) => {
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('D');
  await expect(speciesBadge(page, 'Pecari tajacu')).toHaveCount(0);
  await focusFrame(page, 'IMG002.JPG');
  await page.keyboard.press('d');
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Mule Deer');
});

Given('keys have been assigned locally', async ({ page }) => {
  await speciesAssignKey(page, 'Odocoileus hemionus').click();
  await page.keyboard.press('q');
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('Q');
});

When('the tagger is reopened later in the same browser', async ({ page }) => {
  await page.reload();
  await connect(page);
  await selectCollection(page);
  await openUpload(page);
});

Then('those key assignments are still in effect', async ({ page }) => {
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveText('Q');
  await focusFrame(page, 'IMG002.JPG');
  await page.keyboard.press('q');
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Mule Deer');
});

When('the key is cleared for that species', async ({ page }) => {
  await speciesClearKey(page, 'Odocoileus hemionus').click();
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveCount(0);
});

Then('its local and vocabulary keys no longer apply it', async ({ page }) => {
  await focusFrame(page, 'IMG005.JPG');
  await page.keyboard.press('q');
  await page.keyboard.press('d');
  await expect(gridCell(page, 'IMG005.JPG')).not.toContainText('Mule Deer');
});

Then('the cleared key remains absent after reopening the tagger', async ({ page }) => {
  await page.reload();
  await connect(page);
  await selectCollection(page);
  await openUpload(page);
  await expect(speciesBadge(page, 'Odocoileus hemionus')).toHaveCount(0);
});

// --- Keypress count increment (issue #96) -----------------------------------

When('the bound key is pressed three times', async ({ page }) => {
  // 'D' is the vocabulary key binding for Mule Deer (Odocoileus hemionus).
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.keyboard.press('d');
});

When('the bound key is pressed once', async ({ page }) => {
  await page.keyboard.press('d');
});

Then('the species count on that image is three', async ({ page }) => {
  await expect(appliedChip(page, 'Mule Deer').locator('input[type="number"]')).toHaveValue('3');
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Mule Deer ×3');
});

When('the Ghost key is pressed multiple times', async ({ page }) => {
  // 'G' is the vocabulary key binding for Ghost.
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('g');
});

Then('the image still carries Ghost with a count of one', async ({ page }) => {
  // Ghost renders without a count input (it is always exactly one).
  await expect(gridCell(page, 'IMG002.JPG')).toContainText('Ghost');
  await expect(appliedChip(page, 'Ghost')).toHaveCount(1);
  await expect(appliedChip(page, 'Ghost')).not.toContainText('×');
  await expect
    .poll(async () => {
      const drafts = (await readStore(page, 'drafts')) as {
        mediaPath: string;
        observations: { scientificName: string; count: number }[];
      }[];
      return drafts
        .find((d) => d.mediaPath.endsWith('IMG002.JPG'))
        ?.observations.find((o) => o.scientificName === 'Casper')?.count;
    })
    .toBe(1);
});

Then('each selected image increments the species from its own count', async ({ page }) => {
  await waitForDirtyDrafts(page, 3);
  const drafts = (await readStore(page, 'drafts')) as {
    mediaPath: string;
    observations: { scientificName: string; count: number }[];
  }[];
  const count = (file: string, scientificName: string) =>
    drafts
      .find((d) => d.mediaPath.endsWith(file))
      ?.observations.find((o) => o.scientificName === scientificName)?.count;
  expect(count('IMG001.JPG', 'Odocoileus hemionus')).toBe(3);
  expect(count('IMG002.JPG', 'Odocoileus hemionus')).toBe(1);
  expect(count('IMG003.JPG', 'Odocoileus hemionus')).toBe(1);
  expect(count('IMG003.JPG', 'Casper')).toBeUndefined();
  // Keyboard application is selection-scoped, but must not spill onto an
  // unselected image as the spatial drag/drop paths deliberately do not.
  expect(count('IMG005.JPG', 'Odocoileus hemionus')).toBeUndefined();
  await expect(gridCell(page, 'IMG005.JPG')).not.toContainText('Mule Deer');
});

Given('the saved user profile contains an older species configuration', async ({ page }) => {
  await page.evaluate(() => {
    const key = 'sparcd-tagger-keybindings';
    const stored = JSON.parse(localStorage.getItem(key)!) as {
      state: {
        profiles: Record<
          string,
          {
            overrides: Record<string, string | null>;
            overrideRevisions: Record<string, { at: number; sequence: number; writer: string }>;
            acceptedSpecies?: { scientificName: string; commonName: string; keyBinding: string | null }[];
            acceptedRevision?: { at: number; sequence: number; writer: string };
            pendingSpeciesChange?: unknown;
            pendingRevision?: { at: number; sequence: number; writer: string };
          }
        >;
      };
      version: number;
    };
    const profile = Object.entries(stored.state.profiles).find(([id]) => id !== '__legacy__')![1];
    const revision = { at: Date.now() + 1, sequence: 1, writer: 'bdd-fixture' };
    profile.overrides['Former species'] = '!';
    profile.overrideRevisions['Former species'] = revision;
    profile.acceptedSpecies = [
      { scientificName: 'Odocoileus hemionus', commonName: 'Old Deer Name', keyBinding: 'M' },
      { scientificName: 'Former species', commonName: 'Former Species', keyBinding: 'F' },
    ];
    profile.acceptedRevision = revision;
    delete profile.pendingSpeciesChange;
    profile.pendingRevision = revision;
    localStorage.setItem(key, JSON.stringify(stored));
  });
});

When('the tagger is refreshed with its restored session', async ({ page }) => {
  await page.reload();
  await connect(page);
});

Then('no vocabulary reconciliation is performed', async ({ page }) => {
  await expect(speciesChangedDialog(page)).toHaveCount(0);
  const pending = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('sparcd-tagger-keybindings')!) as {
      state: { profiles: Record<string, { pendingSpeciesChange?: unknown }> };
    };
    return Object.values(stored.state.profiles)[0].pendingSpeciesChange;
  });
  expect(pending).toBeUndefined();
});

When('the user explicitly logs in with the current server vocabulary', async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
  await expect(speciesChangedDialog(page)).toHaveCount(0);
  await connect(page);
  await expect(
    page.getByRole('alertdialog', { name: 'Species vocabulary has changed' }),
  ).toBeVisible();
});

const speciesChangedDialog = (page: Page) =>
  page.getByRole('alertdialog', { name: 'Species vocabulary has changed' });

Then('a blocking message lists added, removed and updated species', async ({ page }) => {
  const dialog = speciesChangedDialog(page);
  await expect(dialog).toContainText('Coyote');
  await expect(dialog).toContainText('Former Species');
  await expect(dialog).toContainText('Mule Deer');
  await expect(dialog.getByRole('button', { name: 'I understand' })).toBeFocused();
});

Then('reopening again does not bypass the required acknowledgement', async ({ page }) => {
  await page.reload();
  await connect(page);
  await expect(speciesChangedDialog(page)).toBeVisible();
});

When('the vocabulary change is acknowledged', async ({ page }) => {
  await speciesChangedDialog(page).getByRole('button', { name: 'I understand' }).click();
});

Then('removed-species bindings are pruned and the message stays acknowledged', async ({ page }) => {
  const removed = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('sparcd-tagger-keybindings')!) as {
      state: { profiles: Record<string, { overrides: Record<string, string | null> }> };
    };
    return Object.values(stored.state.profiles)[0].overrides['Former species'];
  });
  expect(removed).toBeNull();
  await page.reload();
  await connect(page);
  await expect(speciesChangedDialog(page)).toHaveCount(0);
});

// --- Loupe ------------------------------------------------------------------

const loupe = (page: Page) =>
  page.locator('div[role="dialog"]').filter({ hasText: 'Mountain Lion' });

Given('a species row carries a reference image', async ({ page }) => {
  await expect(speciesRow(page, 'Puma concolor').locator('img')).toBeVisible();
});

When('its enlarge control is used', async ({ page }) => {
  await speciesLoupeButton(page, 'Puma concolor').click();
  await expect(loupe(page)).toBeVisible();
});

Then('the reference image is shown enlarged over the workspace', async ({ page }) => {
  const img = loupe(page).locator('img[alt="Mountain Lion"]');
  await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  expect(box.width).toBeGreaterThan(40);
});

Then('no tagging keystroke takes effect while it is open', async ({ page }) => {
  const before = (await gridCell(page, 'IMG001.JPG').textContent()) ?? '';
  await page.keyboard.press('d');
  await page.keyboard.press('g');
  await expect(loupe(page)).toBeVisible();
  await expect(gridCell(page, 'IMG001.JPG')).toHaveText(before);
});

Then('Escape, the close control or a click outside dismisses it', async ({ page }) => {
  await page.keyboard.press('Escape');
  await expect(loupe(page)).toHaveCount(0);

  await speciesLoupeButton(page, 'Puma concolor').click();
  await loupe(page).getByRole('button', { name: 'Close' }).click();
  await expect(loupe(page)).toHaveCount(0);

  await speciesLoupeButton(page, 'Puma concolor').click();
  await loupe(page).click({ position: { x: 4, y: 4 } });
  await expect(loupe(page)).toHaveCount(0);
});

// --- Empty upload (corrected scenario) --------------------------------------

Given('an upload whose canonical media list has no images is opened', async ({ page, s3 }) => {
  s3.put(BUCKET, `${PREFIX_A}media.csv`, '', 'text/csv');
  await page.reload();
  await connect(page);
  await selectCollection(page);
  await page
    .locator('button')
    .filter({ hasText: 'priortagger' })
    .filter({ hasText: 'Open →' })
    .click();
});

Then('the workspace states that the upload has no taggable images', async ({ page }) => {
  await expect(page.getByText('This upload has no taggable images.')).toBeVisible();
});

Then('no species panel is offered', async ({ page }) => {
  await expect(page.getByLabel('Filter species')).toHaveCount(0);
  await expect(page.locator('div.group')).toHaveCount(0);
});

// --- Drag and drop ----------------------------------------------------------

const focusDropZone = (page: Page) => page.getByTestId('focus-drop-zone');

When('a species tile is dragged onto the image area in the Focus view', async ({ page }) => {
  await enterFocusView(page);
  await speciesRow(page, 'Canis latrans').dragTo(focusDropZone(page));
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
});

When('that species tile is dragged onto the image area in the Focus view', async ({ page }) => {
  await enterFocusView(page);
  await speciesRow(page, 'Odocoileus hemionus').dragTo(focusDropZone(page));
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
});

When('the Ghost tile is dragged onto the image area in the Focus view', async ({ page }) => {
  await enterFocusView(page);
  await ghostRow(page).dragTo(focusDropZone(page));
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
});

When('a species tile is dragged onto a different image tile in Overview', async ({ page }) => {
  await speciesRow(page, 'Canis latrans').dragTo(gridCell(page, 'IMG005.JPG'));
});

Then('only the Overview image under the drop receives the species', async ({ page }) => {
  await expect(positionReadout(page)).toHaveText('3 selected');
  await waitForDirtyDrafts(page, 1);
  const drafts = (await readStore(page, 'drafts')) as {
    mediaPath: string;
    observations: { scientificName: string; count: number }[];
  }[];
  const withCoyote = drafts.filter((d) =>
    d.observations.some((o) => o.scientificName === 'Canis latrans'),
  );
  expect(withCoyote).toHaveLength(1);
  expect(withCoyote[0].mediaPath).toMatch(/IMG005\.JPG$/);
  expect(withCoyote[0].observations.find((o) => o.scientificName === 'Canis latrans')?.count).toBe(1);
  await expect(gridCell(page, 'IMG005.JPG')).toContainText('Coyote');
});

Then("that species' count is incremented by one", async ({ page }) => {
  await expandApplied(page);
  // IMG001 carries Mule Deer at count 2 in the fixture; one drag increments to 3.
  await expect(appliedChip(page, 'Mule Deer').locator('input[type="number"]')).toHaveValue('3');
});

Then('only the focused image receives the dropped species', async ({ page }) => {
  await expect(positionReadout(page)).toHaveText('3 selected');
  await waitForDirtyDrafts(page, 1);
  const drafts = (await readStore(page, 'drafts')) as {
    mediaPath: string;
    observations: { scientificName: string; count: number }[];
  }[];
  const withCoyote = drafts.filter((d) =>
    d.observations.some((o) => o.scientificName === 'Canis latrans'),
  );
  expect(withCoyote).toHaveLength(1);
  expect(withCoyote[0].mediaPath).toMatch(/IMG003\.JPG$/);
  expect(
    withCoyote[0].observations.find((o) => o.scientificName === 'Canis latrans')?.count,
  ).toBe(1);
});

// --- Local holding ----------------------------------------------------------

When('species are applied to images', async ({ page }) => {
  await focusFrame(page, 'IMG002.JPG');
  await speciesApply(page, 'Canis latrans').click();
  await focusFrame(page, 'IMG005.JPG');
  await speciesApply(page, 'Pecari tajacu').click();
});

Then('the identifications are kept in this browser', async ({ page }) => {
  await waitForDirtyDrafts(page, 2);
  const drafts = (await readStore(page, 'drafts')) as { observations: unknown[] }[];
  expect(drafts.filter((d) => d.observations.length > 0)).toHaveLength(2);
});

Then('the workspace reports how many local edits are unsaved', async ({ page }) => {
  await expect(page.getByText(/2 unsaved · discard/)).toBeVisible();
});

Then("the collection's stored files are unchanged until a sync is run", async ({ page, s3 }) => {
  expect(s3.puts).toHaveLength(0);
  expect(s3.text(BUCKET, `${PREFIX_A}observations.csv`)).toBe(observationsCsv(PREFIX_A, OBS_A));
  await expect(positionReadout(page)).toBeVisible();
});
