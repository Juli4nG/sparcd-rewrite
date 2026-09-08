import {
  Given,
  When,
  Then,
  expect,
  openApp,
  openAppConnected,
  openWorkspace,
  openSettings,
  sectionTab,
  collectionRail,
  collectionButton,
  visibleNav,
  ENDPOINT,
  APP_URL,
} from './support/world';
import { installS3Mock } from './support/s3mock';
import { COLLECTION_NAME } from './support/data';
import {
  makeLocalEdit,
  openSyncDialog,
  settingsDryRunCheckbox,
  burstCheckbox,
  setSyncDryRun,
  readStore,
  waitForDirtyDrafts,
} from './support/flows';

// --- Background / shared givens ---------------------------------------------

Given('the tagger is open in a browser', async ({ page }) => {
  await openApp(page);
});

Given('the tagger is connected', async ({ page }) => {
  await openAppConnected(page);
});

Given('the connection screen is shown', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

// --- Credential gate --------------------------------------------------------

When('any of the endpoint, access key or secret key is empty', async ({ page }) => {
  await page.locator('#endpoint').fill(ENDPOINT);
  await page.locator('#accessKey').fill('testkey');
  await page.locator('#secretKey').fill('');
});

Then('the Connect button is disabled', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
});

Then('the tagger shows no collections or images', async ({ page }) => {
  await expect(visibleNav(page)).toHaveCount(0);
  await expect(page.locator('img[src*="X-Amz-Signature"]')).toHaveCount(0);
});

When('an endpoint is entered', async ({ page }) => {
  await page.locator('#endpoint').fill('minio.example.org:9000');
});

Then('the region, path-style addressing and HTTPS settings are inferred from it', async ({
  page,
}) => {
  await page.getByRole('button', { name: '+ Advanced' }).click();
  await expect(page.locator('#region')).toHaveValue('us-east-1');
  await expect(
    page.locator('label').filter({ hasText: 'Force path-style' }).locator('input'),
  ).toBeChecked();
  await expect(
    page.locator('label').filter({ hasText: 'Secure (HTTPS)' }).locator('input'),
  ).toBeChecked();
});

Then('those inferred settings are only shown under {string}', async ({ page }, label: string) => {
  await page.getByRole('button', { name: `− ${label}` }).click();
  await expect(page.locator('#region')).toHaveCount(0);
  await page.getByRole('button', { name: `+ ${label}` }).click();
  await expect(page.locator('#region')).toBeVisible();
});

Then('any of them can be overridden before connecting', async ({ page }) => {
  await page.locator('#region').fill('eu-west-2');
  await expect(page.locator('#region')).toHaveValue('eu-west-2');
  const pathStyle = page.locator('label').filter({ hasText: 'Force path-style' }).locator('input');
  await pathStyle.uncheck();
  await expect(pathStyle).not.toBeChecked();
  const secure = page.locator('label').filter({ hasText: 'Secure (HTTPS)' }).locator('input');
  await secure.uncheck();
  await expect(secure).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

// --- Secret is never persisted ----------------------------------------------

Given('a successful connection was made earlier in this browser', async ({ page }) => {
  await openAppConnected(page);
});

When('the tagger is opened again in a new page load', async ({ page }) => {
  await page.reload();
});

Then('it is still connected without asking for the secret again', async ({ page }) => {
  await expect(sectionTab(page, 'Browse')).toBeVisible();
  await expect(page.locator('#secretKey')).toHaveCount(0);
});

// The session lives in sessionStorage, which is per-tab: emptying it and
// reloading is exactly what a new tab sees — localStorage survives to pre-fill
// the form, and no other tab is open to relay the secret.
When('the tab is closed and the tagger is opened in a new one', async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

Then('the endpoint and access key are pre-filled from the previous connection', async ({ page }) => {
  await expect(page.locator('#endpoint')).toHaveValue(ENDPOINT);
  await expect(page.locator('#accessKey')).toHaveValue('testkey');
});

Then('the secret key field is empty', async ({ page }) => {
  await expect(page.locator('#secretKey')).toHaveValue('');
});

Then('the tagger stays on the connection screen until the secret is re-entered', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await expect(visibleNav(page)).toHaveCount(0);
  await page.locator('#secretKey').fill('testsecret');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(sectionTab(page, 'Browse')).toBeVisible();
});

// --- Cross-tab session ------------------------------------------------------

Given("one tab of a SPARC'd tool is already connected in this browser", async ({ page }) => {
  await openAppConnected(page);
});

When('another tab of the tagger is opened', async ({ context, s3, scratch }) => {
  const second = await context.newPage();
  await installS3Mock(second, s3);
  await second.goto(APP_URL);
  scratch.second = second;
});

Then('it adopts the live connection without asking for the secret again', async ({ scratch }) => {
  const second = scratch.second as import('@playwright/test').Page;
  await expect(sectionTab(second, 'Browse')).toBeVisible();
  await expect(second.locator('#secretKey')).toHaveCount(0);
});

Given('two tabs are connected to the same store', async ({ page, context, s3, scratch }) => {
  await openAppConnected(page);
  const second = await context.newPage();
  await installS3Mock(second, s3);
  await second.goto(APP_URL);
  await expect(sectionTab(second, 'Browse')).toBeVisible();
  scratch.second = second;
});

When('one of them disconnects', async ({ page }) => {
  await page.locator('header').getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

Then('the other returns to the connection screen', async ({ scratch }) => {
  const second = scratch.second as import('@playwright/test').Page;
  await expect(second.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

Then("it no longer shows the previous connection's collections or images", async ({ scratch }) => {
  const second = scratch.second as import('@playwright/test').Page;
  await expect(collectionRail(second)).toHaveCount(0);
  await expect(second.getByText(COLLECTION_NAME)).toHaveCount(0);
});

// --- Tag gate ---------------------------------------------------------------

When('no upload has been opened from Browse', async ({ page }) => {
  await expect(sectionTab(page, 'Browse')).toBeVisible();
});

Then('the {string} section tab is disabled', async ({ page }, label: string) => {
  await expect(sectionTab(page, label)).toBeDisabled();
});

Then('Browse, History and Settings remain available', async ({ page }) => {
  for (const label of ['Browse', 'History', 'Settings']) {
    await expect(sectionTab(page, label)).toBeEnabled();
  }
});

// --- Identity ---------------------------------------------------------------

When('a tagger identity is entered in Settings', async ({ page }) => {
  await openSettings(page);
  await page.locator('#user').fill('jgonzalez');
  await expect(page.locator('#user')).toHaveValue('jgonzalez');
});

Then(
  'that identity is used for the audit-snapshot path and the edit comment of every sync',
  async ({ page, s3 }) => {
    await page.getByRole('button', { name: 'Browse', exact: true }).first().click();
    await collectionButton(page, COLLECTION_NAME).click();
    await openWorkspaceFromBrowse(page);
    await makeLocalEdit(page);
    await openSyncDialog(page);
    await expect(page.getByText(/snapshot →/)).toContainText('/jgonzalez/');
    await setSyncDryRun(page, false);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByText('Synced — canonical files replaced.')).toBeVisible();

    const written = s3.puts.filter((p) => p.key.endsWith('UploadMeta.json'));
    expect(written.length).toBeGreaterThan(0);
    const meta = JSON.parse(written[written.length - 1].body) as { editComments: string[] };
    expect(meta.editComments.join('\n')).toContain('jgonzalez');
    expect(s3.puts.some((p) => p.key.includes('.sparcd-tagger-snapshots/jgonzalez/'))).toBe(true);
  },
);

Then('a live sync or restore cannot be run while the identity is empty', async ({ page }) => {
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  await openSettings(page);
  await page.locator('#user').fill('');
  await sectionTab(page, 'Tag').click();
  await openSyncDialog(page);
  await expect(page.getByText('Set a Tagger identity in Settings first')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sync now|Run dry-run/ })).toBeDisabled();
});

// --- Session defaults -------------------------------------------------------

When('Settings is opened for the first time in a session', async ({ page }) => {
  await openSettings(page);
});

When('Settings is opened', async ({ page }) => {
  await openSettings(page);
});

Then('{string} is switched on', async ({ page }, label: string) => {
  await expect(page.locator('label').filter({ hasText: label }).locator('input')).toBeChecked();
});

Then('{string} is switched off', async ({ page }, label: string) => {
  await expect(page.locator('label').filter({ hasText: label }).locator('input')).not.toBeChecked();
});

Then(
  'Sync previews what it would write without changing anything until it is switched off',
  async ({ page, s3 }) => {
    await expect(settingsDryRunCheckbox(page)).toBeChecked();
    // An identity is required before the dialog will run anything at all — even
    // a dry-run — so set one and prove the dry-run still writes nothing.
    await page.locator('#user').fill('jgonzalez');
    await sectionTab(page, 'Browse').click();
    await collectionButton(page, COLLECTION_NAME).click();
    await openWorkspaceFromBrowse(page);
    await makeLocalEdit(page);
    await openSyncDialog(page);
    await expect(page.getByText(/Would write \d+ file\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Run dry-run' }).click();
    await expect(page.getByText('Dry-run complete — nothing was written.')).toBeVisible();
    expect(s3.puts).toHaveLength(0);
  },
);

Then('the Overview shows a flat strip of images with no burst bands', async ({ page }) => {
  await page.getByRole('button', { name: 'Browse', exact: true }).first().click();
  await collectionButton(page, COLLECTION_NAME).click();
  await openWorkspaceFromBrowse(page);
  await expect(page.getByText(/^Burst \d+ ·/)).toHaveCount(0);
});

Then('switching it on reveals a threshold between {int} and {int} seconds', async (
  { page },
  lo: number,
  hi: number,
) => {
  await sectionTab(page, 'Settings').click();
  await burstCheckbox(page).check();
  const slider = page.locator('#burst');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('min', String(lo));
  await expect(slider).toHaveAttribute('max', String(hi));
});

// --- Disconnect -------------------------------------------------------------

Given('there are unsaved local edits in this browser', async ({ page }) => {
  await openWorkspace(page);
  await makeLocalEdit(page);
  await expect(page.getByText(/1 unsaved · discard/)).toBeVisible();
  await waitForDirtyDrafts(page, 1);
});

When('Disconnect is chosen in Settings', async ({ page }) => {
  await openSettings(page);
  await page.locator('main').getByRole('button', { name: 'Disconnect' }).click();
});

Then('the tagger reports how many unsynced edits exist', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Unsynced local edits' })).toBeVisible();
  await expect(page.getByText(/You have\s*1\s*unsynced tag/)).toBeVisible();
});

Then(
  'it offers to cancel, to review the unsynced edits in History, or to discard them and disconnect',
  async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review unsynced' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discard & disconnect' })).toBeVisible();
  },
);

Given('there are no unsaved local edits', async ({ page }) => {
  await openAppConnected(page);
  // Something local to prove the wipe actually happens.
  await page.evaluate(() =>
    localStorage.setItem(
      'sparcd-tagger-keybindings',
      JSON.stringify({ state: { overrides: { 'Canis latrans': 'c' } }, version: 0 }),
    ),
  );
});

When('Disconnect is chosen', async ({ page }) => {
  await openSettings(page);
  await page.locator('main').getByRole('button', { name: 'Disconnect' }).click();
});

Then(
  'local work is cleared while scoped keybinding profiles are retained',
  async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sparcd-tagger-keybindings'))).not.toBeNull();
    expect(await readStore(page, 'drafts')).toHaveLength(0);
    expect(await readStore(page, 'uploads')).toHaveLength(0);
    expect(await readStore(page, 'syncJournals')).toHaveLength(0);
  },
);

Then('the tagger returns to the connection screen ready for the next person', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.locator('#secretKey')).toHaveValue('');
});

// --- Theme ------------------------------------------------------------------

When('the theme control in the header is used', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to dark' }).click();
});

Then('the workspace switches between the light and dark presentation', async ({ page }) => {
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

Then(
  "the choice is remembered on this machine, shared with the other SPARC'd tools",
  async ({ page }) => {
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    // One key for every tool on this origin, so walking to another one from the
    // brand switcher lands in the same appearance.
    expect(await page.evaluate(() => localStorage.getItem('sparcd-theme'))).toBe('dark');
  },
);

// --- helpers ----------------------------------------------------------------

async function openWorkspaceFromBrowse(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('button').filter({ hasText: 'priortagger' }).filter({ hasText: 'Open →' }).click();
  await expect(page.getByRole('button', { name: 'Sync…' })).toBeVisible();
  await expect(page.locator('button[title="IMG001.JPG"]')).toBeVisible();
}
