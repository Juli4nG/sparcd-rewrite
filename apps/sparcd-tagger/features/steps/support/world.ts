// Shared fixtures + page objects for the as-built feature suite.

import { expect, type Page, type Locator } from '@playwright/test';
import { test as base, createBdd } from 'playwright-bdd';
import { MockS3, installS3Mock } from './s3mock';
import { seedFixtures, COLLECTION_NAME } from './data';

export const APP_URL = '/sparcd-exploration/tagger/';
export const ENDPOINT = 'http://localhost:5312';

/** Scratch state a scenario carries between its own steps. */
export type Scratch = {
  focusIndexBefore?: number;
  selectedBefore?: string[];
  putsBefore?: number;
  storedBefore?: Record<string, string>;
  note?: string;
  [k: string]: unknown;
};

export const test = base.extend<{ s3: MockS3; scratch: Scratch }>({
  s3: async ({}, use) => {
    const s3 = new MockS3();
    seedFixtures(s3);
    await use(s3);
  },
  // Routes are installed on the page fixture so every scenario gets the mock,
  // whichever step happens to navigate first.
  page: async ({ page, s3 }, use) => {
    await installS3Mock(page, s3);
    await use(page);
  },
  scratch: async ({}, use) => {
    await use({} as Scratch);
  },
});

export const { Given, When, Then } = createBdd(test);
export { expect };

// --- Page objects -----------------------------------------------------------

export const visibleNav = (page: Page): Locator =>
  page.locator('nav[aria-label="Sections"]:visible');

export const sectionTab = (page: Page, label: string): Locator =>
  visibleNav(page).getByRole('button', { name: label, exact: true });

export const collectionRail = (page: Page): Locator => page.locator('aside');

export const collectionButton = (page: Page, name: string): Locator =>
  collectionRail(page).getByRole('button').filter({ hasText: name });

export const uploadRow = (page: Page, user: string): Locator =>
  page.locator('button').filter({ hasText: user }).filter({ hasText: 'Open →' });

/** The species-panel row for a species, addressed by its scientific name. */
export const speciesRow = (page: Page, scientific: string): Locator =>
  page.locator('div.group').filter({ hasText: scientific }).first();

/** The row's apply button — distinguished from the loupe/assign-key siblings by
 *  its title, which the component always sets. */
export const speciesApply = (page: Page, scientific: string): Locator =>
  speciesRow(page, scientific).locator(
    'button[title^="Apply"], button[title$="already applied"], button[title="Focus an image first"]',
  );

export const speciesTile = (page: Page, scientific: string): Locator =>
  speciesRow(page, scientific).locator('button[title^="Select "]');

export const speciesLoupeButton = (page: Page, scientific: string): Locator =>
  speciesRow(page, scientific).locator('button[title="Enlarge reference"]');

export const speciesAssignKey = (page: Page, scientific: string): Locator =>
  speciesRow(page, scientific).locator('button[title="Assign a key to this species"]');

export const speciesClearKey = (page: Page, scientific: string): Locator =>
  speciesRow(page, scientific).locator('button[title="Clear this key"]');

export const speciesBadge = (page: Page, scientific: string): Locator =>
  speciesRow(page, scientific).locator('kbd');

export const ghostRow = (page: Page): Locator => speciesRow(page, 'Casper');

export const gridCell = (page: Page, fileName: string): Locator =>
  page.locator(`button[title="${fileName}"]`);

/** A row of the list Overview (list cells carry the name on an inner span). */
export const listRow = (page: Page, fileName: string): Locator =>
  page.locator('button').filter({ has: page.locator(`span[title="${fileName}"]`) });

/** Grid tile titles in rendered order. */
export async function tileOrder(page: Page): Promise<string[]> {
  return page
    .locator('button[title$=".JPG"], button[title$=".MP4"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
}

export const focusedTile = (page: Page): Locator =>
  page.locator('button[aria-current="true"][title]');

export const selectedTiles = (page: Page): Locator =>
  page.locator('button[title].ring-2');

/** Position readout in the Tag toolbar: "3 / 6" or "2 selected". */
export const positionReadout = (page: Page): Locator =>
  page.locator('span.font-mono').filter({ hasText: /^\d+ \/ \d+$|^\d+ selected$/ }).first();

export const speciesFilter = (page: Page): Locator => page.getByLabel('Filter species');

export const imageSearch = (page: Page): Locator => page.getByPlaceholder('Find image…');

// --- Flows ------------------------------------------------------------------

export async function openApp(page: Page): Promise<void> {
  await page.goto(APP_URL);
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
}

export async function connect(page: Page): Promise<void> {
  if (await sectionTab(page, 'Browse').count()) return;
  if (!(await page.locator('#endpoint').count())) await openApp(page);
  await page.locator('#endpoint').fill(ENDPOINT);
  await page.locator('#accessKey').fill('testkey');
  await page.locator('#secretKey').fill('testsecret');
  await page.getByLabel('Remember endpoint & access key on this device').check();
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(sectionTab(page, 'Browse')).toBeVisible();
}

export async function openAppConnected(page: Page): Promise<void> {
  // Idempotent: several Givens reach for "connected" after a Background has
  // already got there, and re-navigating would throw the session away.
  if (!(await sectionTab(page, 'Browse').count())) {
    await openApp(page);
    await connect(page);
  }
  // The collection rail settles before anything else is meaningful.
  await expect(collectionButton(page, COLLECTION_NAME)).toBeVisible();
}

export async function selectCollection(page: Page, name = COLLECTION_NAME): Promise<void> {
  await collectionButton(page, name).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Uploads in ${name}`) })).toBeVisible();
}

export async function openUpload(page: Page, user = 'priortagger'): Promise<void> {
  await uploadRow(page, user).click();
  await expect(page.getByRole('button', { name: 'Sync…' })).toBeVisible();
  // Wait for media.csv to resolve into tiles.
  await expect(page.locator('button[title$=".JPG"], button[title$=".MP4"]').first()).toBeVisible();
}

/** The default entry point for every tagging scenario. */
export async function openWorkspace(page: Page, user = 'priortagger'): Promise<void> {
  await openAppConnected(page);
  await selectCollection(page);
  await openUpload(page, user);
}

export async function openSettings(page: Page): Promise<void> {
  await sectionTab(page, 'Settings').click();
  await expect(page.locator('#user')).toBeVisible();
}

/** Focus a specific frame in the Overview grid by file name. */
export async function focusFrame(page: Page, fileName: string): Promise<void> {
  await gridCell(page, fileName).click();
  await expect(gridCell(page, fileName)).toHaveAttribute('aria-current', 'true');
}

export async function enterFocusView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
}
