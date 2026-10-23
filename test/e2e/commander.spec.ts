import { expect, test } from '@playwright/test';
import {
  connectMockedFtp,
  deliverHostMessage,
  getHostMessages,
  installMockBridge,
  localEntries,
  markMockFtpConnected,
  remoteEntries,
  waitForHostMessage
} from './support/bridge';

test.beforeEach(async ({ page }) => installMockBridge(page));

async function chooseProtocol(page: import('@playwright/test').Page, protocol: 'ftp' | 'ftps' | 'sftp') {
  const labels = { ftp: 'FTP', ftps: 'FTPS', sftp: 'SFTP (SSH)' };
  await page.getByRole('button', { name: 'Connection protocol' }).click();
  await page.getByRole('region', { name: 'Connection protocol choices' }).getByRole('button', { name: labels[protocol], exact: true }).click();
}

test('renders both panes with the host logo and VS Code theme colors', async ({ page }) => {
  await expect(page.getByText('LOCAL', { exact: true })).toBeVisible();
  await expect(page.getByText('REMOTE SERVER', { exact: true })).toBeVisible();
  await expect(page.locator('.brand-mark')).toHaveJSProperty('naturalWidth', 128);
  await expect(page.locator('bm-root')).toHaveCSS('color', 'rgb(159, 173, 177)');
  await expect(page.locator('bm-file-pane .pane').first()).toHaveCSS('background-color', 'rgb(15, 28, 33)');
  await expect(page.getByRole('button', { name: /alpha\.txt/ })).toBeVisible();
  await expect(page.getByText('Connect to view the remote directory.')).toBeVisible();
});

test('connect stays pending until the host responds, then reports failure and can retry', async ({ page }) => {
  const firstAttempt = connectMockedFtp(page);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await expect(page.getByRole('status', { name: 'Loading remote folder' })).toBeVisible();
  expect(await firstAttempt).toMatchObject({
    type: 'connect',
    profile: { host: 'ftp.example.test', username: 'tester', protocol: 'ftps' },
    password: 'test-password'
  });

  await deliverHostMessage(page, { type: 'error', operation: 'connect', error: 'Login rejected by test fixture.' });
  const errorDialog = page.getByRole('alertdialog');
  await expect(errorDialog).toContainText('Server connection failed');
  await expect(errorDialog.getByRole('button', { name: 'OK' })).toBeFocused();
  await errorDialog.getByRole('button', { name: 'OK' }).click();

  const retryAttempt = connectMockedFtp(page);
  await expect(retryAttempt).resolves.toMatchObject({ type: 'connect' });
  await markMockFtpConnected(page);
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(page.getByRole('button', { name: /alpha-remote\.txt/ })).toBeVisible();
});

test('disconnect and a dropped connection update the FTP pane from host messages', async ({ page }) => {
  const attempt = connectMockedFtp(page);
  await attempt;
  await markMockFtpConnected(page);

  const disconnect = waitForHostMessage(page, 'disconnect');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  expect(await disconnect).toMatchObject({ type: 'disconnect' });
  await deliverHostMessage(page, { type: 'data', remoteEntries: [], connected: false });
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByText('Connect to view the remote directory.')).toBeVisible();

  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  await deliverHostMessage(page, {
    type: 'data', remoteEntries: [], connected: false,
    transfer: 'FTP connection lost. Click Connect to reconnect.'
  });
  await expect(page.getByText('FTP connection lost. Click Connect to reconnect.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

test('selection is cleared when filtering hides the selected row', async ({ page }) => {
  const localPane = page.locator('bm-file-pane').first();
  const alpha = localPane.getByRole('button', { name: /alpha\.txt/ });
  await alpha.click();
  await expect(alpha).toHaveClass(/selected/);

  const filter = localPane.getByRole('searchbox', { name: 'Filter local files' });
  await filter.fill('beta');
  await expect(localPane.locator('.file-row')).toHaveCount(1);
  await expect(localPane.getByRole('button', { name: /beta\.txt/ })).not.toHaveClass(/selected/);
  await filter.clear();
  await expect(localPane.getByRole('button', { name: /alpha\.txt/ })).not.toHaveClass(/selected/);
});

test('remote folder activation and breadcrumbs send exact navigation requests', async ({ page }) => {
  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  const remotePane = page.locator('bm-file-pane').nth(1);

  const openFolder = waitForHostMessage(page, 'navigate');
  await remotePane.getByRole('button', { name: /^folder/ }).dblclick();
  expect(await openFolder).toMatchObject({ type: 'navigate', pane: 'remote', path: '/folder' });
  await deliverHostMessage(page, {
    type: 'data', remotePath: '/folder', remoteEntries: [], connected: true
  });
  await expect(remotePane.getByRole('navigation', { name: 'Remote folder path' })).toContainText('folder');

  const goRoot = waitForHostMessage(page, 'navigate');
  await remotePane.locator('nav[aria-label="Remote folder path"] button[title="Open /"]').click();
  expect(await goRoot).toMatchObject({ type: 'navigate', pane: 'remote', path: '/' });
});

test('copy progress updates deterministically and closes when the host clears it', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Filter local files' }).focus();
  await deliverHostMessage(page, {
    type: 'copy-progress',
    progress: {
      direction: 'download', name: 'alpha-remote.txt', total: 100, transferred: 25,
      verified: 0, totalItems: 1, copiedItems: 0, verifiedItems: 0, phase: 'transfer'
    }
  });
  const dialog = page.getByRole('dialog', { name: 'Downloading from server' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('progressbar', { name: 'Copied bytes' })).toHaveAttribute('value', '25');
  await expect(dialog).toBeFocused();

  await deliverHostMessage(page, {
    type: 'copy-progress',
    progress: {
      direction: 'download', name: 'alpha-remote.txt', total: 100, transferred: 100,
      verified: 100, totalItems: 1, copiedItems: 1, verifiedItems: 1, phase: 'verify'
    }
  });
  await expect(dialog.getByRole('progressbar', { name: 'Checked bytes' })).toHaveAttribute('value', '100');
  await deliverHostMessage(page, { type: 'copy-progress', progress: null });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('searchbox', { name: 'Filter local files' })).toBeFocused();
});

test('error modal traps focus, blocks background input and restores the previous focus', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Filter local files' });
  await search.focus();
  await deliverHostMessage(page, { type: 'error', operation: 'refresh', error: 'Fixture listing failed.' });

  const dialog = page.getByRole('alertdialog');
  const ok = dialog.getByRole('button', { name: 'OK' });
  await expect(ok).toBeFocused();
  await ok.press('Tab');
  await expect(ok).toBeFocused();
  await expect(page.locator('.commander-background')).toHaveAttribute('inert', '');

  await ok.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();
});

test('keyboard shortcuts select rows, search in the active pane and switch panes', async ({ page }) => {
  const list = page.locator('bm-file-pane').first().locator('.file-list');
  await list.dispatchEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true });
  await expect(list.locator('.file-row.selected')).toHaveCount(localEntries.length);

  await list.getByRole('button', { name: /alpha\.txt/ }).press('Space');
  await expect(list.locator('.file-row.selected')).toHaveCount(localEntries.length - 1);

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })));
  await expect(page.getByRole('searchbox', { name: 'Filter local files' })).toBeFocused();

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  await expect(page.locator('bm-file-pane').nth(1).locator('.pane')).toHaveClass(/active/);
});

test('sorting and filtering remain independent between panes', async ({ page }) => {
  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  const localPane = page.locator('bm-file-pane').first();
  const remotePane = page.locator('bm-file-pane').nth(1);

  await localPane.getByRole('button', { name: 'Name, sorted ascending' }).click();
  await expect(localPane.getByRole('button', { name: 'Name, sorted descending' })).toBeVisible();
  await expect(localPane.locator('.file-row .file-name').nth(1)).toContainText('gamma.log');
  await remotePane.getByRole('searchbox', { name: 'Filter remote files' }).fill('beta-remote');

  await expect(localPane.locator('.file-row')).toHaveCount(localEntries.length);
  await expect(localPane.locator('.file-row .file-name').nth(1)).toContainText('gamma.log');
  await expect(remotePane.locator('.file-row')).toHaveCount(1);
  await expect(remotePane.locator('.file-row').first()).toContainText('beta-remote.txt');
});

test('context menus expose local-relative and remote-absolute copy contracts', async ({ page }) => {
  const localPane = page.locator('bm-file-pane').first();
  await localPane.getByRole('button', { name: /alpha\.txt/ }).click({ button: 'right' });
  const localMenu = page.getByRole('menu');
  await expect(localMenu.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
  await expect(localMenu.getByRole('menuitem', { name: 'Copy Relative Path' })).toBeEnabled();
  const relativeCopy = waitForHostMessage(page, 'copy-path');
  await localMenu.getByRole('menuitem', { name: 'Copy Relative Path' }).click();
  expect(await relativeCopy).toMatchObject({ type: 'copy-path', pane: 'local', path: '/workspace/alpha.txt', relative: true });

  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  const remotePane = page.locator('bm-file-pane').nth(1);
  await remotePane.getByRole('button', { name: /alpha-remote\.txt/ }).click({ button: 'right' });
  const remoteMenu = page.getByRole('menu');
  await expect(remoteMenu.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
  await expect(remoteMenu.getByRole('menuitem', { name: 'Copy Relative Path' })).toHaveCount(0);
  const absoluteCopy = waitForHostMessage(page, 'copy-path');
  await remoteMenu.getByRole('menuitem', { name: 'Copy Path' }).click();
  expect(await absoluteCopy).toMatchObject({ type: 'copy-path', pane: 'remote', path: '/alpha-remote.txt', relative: false });
});

test('connection form preserves FTP and SFTP protocol payloads and applies port defaults', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Server' }).fill('ftp.example.test');
  await page.getByRole('textbox', { name: 'Username' }).fill('tester');
  await page.getByLabel('Password').fill('test-password');
  const port = page.getByLabel('Port');
  await chooseProtocol(page, 'ftp');
  await chooseProtocol(page, 'sftp');
  await expect(port).toHaveValue('22');
  await port.fill('2022');
  await chooseProtocol(page, 'ftp');
  await expect(port).toHaveValue('2022');
  await chooseProtocol(page, 'sftp');
  await expect(port).toHaveValue('2022');
  await chooseProtocol(page, 'ftp');
  const message = waitForHostMessage(page, 'connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(message).resolves.toMatchObject({
    type: 'connect', profile: { host: 'ftp.example.test', username: 'tester', protocol: 'ftp' }, password: 'test-password'
  });
  expect(await getHostMessages(page, 'connect')).toHaveLength(1);
  expect(remoteEntries.map((entry) => entry.name)).toContain('alpha-remote.txt');
});

test('SFTP connect error and retry keep the chosen custom port and protocol', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Server' }).fill('sftp.example.test');
  await page.getByRole('textbox', { name: 'Username' }).fill('tester');
  await page.getByLabel('Password').fill('test-password');
  await page.getByLabel('Port').fill('2222');
  await chooseProtocol(page, 'sftp');

  const first = waitForHostMessage(page, 'connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await first).toMatchObject({ type: 'connect', profile: { host: 'sftp.example.test', port: 2222, username: 'tester', protocol: 'sftp' }, password: 'test-password' });
  await deliverHostMessage(page, { type: 'error', operation: 'connect', error: 'Host key was not trusted.' });
  const errorDialog = page.getByRole('alertdialog');
  await expect(errorDialog).toContainText('Server connection failed');
  await errorDialog.getByRole('button', { name: 'OK' }).click();

  const retry = waitForHostMessage(page, 'connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await retry).toMatchObject({ type: 'connect', profile: { host: 'sftp.example.test', port: 2222, username: 'tester', protocol: 'sftp' } });
});

test('saved SFTP connection fills the form and keeps the SFTP choice visible', async ({ page }) => {
  const ftp = { host: 'ftp.example.test', port: 21, username: 'ftp-user', protocol: 'ftps' };
  const sftp = { host: 'sftp.example.test', port: 2222, username: 'ssh-user', protocol: 'sftp' };
  await deliverHostMessage(page, { type: 'data', savedProfiles: [ftp, sftp] });
  const saved = page.getByRole('button', { name: 'Saved connections' });
  await expect(saved).toBeVisible();
  await saved.click();
  const savedList = page.getByRole('region', { name: 'Saved connections list' });
  await expect(savedList.getByRole('button', { name: 'Select saved connection ftp-user@ftp.example.test:21 · FTPS' })).toBeVisible();
  await expect(savedList.getByRole('button', { name: 'Select saved connection ssh-user@sftp.example.test:2222 · SFTP' })).toBeVisible();
  await page.getByLabel('Password').fill('previous-password');
  await savedList.getByRole('button', { name: 'Select saved connection ssh-user@sftp.example.test:2222 · SFTP' }).click();
  await expect(page.getByRole('textbox', { name: 'Server' })).toHaveValue('sftp.example.test');
  await expect(page.getByLabel('Port')).toHaveValue('2222');
  await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue('ssh-user');
  await expect(page.getByLabel('Password')).toHaveValue('');
  const protocol = page.getByRole('button', { name: 'Connection protocol' });
  await expect(protocol).toContainText('SFTP (SSH)');
  expect((await protocol.boundingBox())?.width).toBeGreaterThanOrEqual(110);
  await protocol.click();
  await expect(page.getByRole('region', { name: 'Connection protocol choices' }).getByRole('button', { name: 'SFTP (SSH)' })).toBeVisible();
  await page.keyboard.press('Escape');
  const request = waitForHostMessage(page, 'connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await request).toMatchObject({ type: 'connect', profile: sftp, password: '' });
  await deliverHostMessage(page, { type: 'error', operation: 'connect', error: 'Unable to connect.' });
  await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
  await expect(protocol).toContainText('SFTP (SSH)');
  await expect(saved).toContainText('ssh-user@sftp.example.test:2222 · SFTP');
});

test('saved connection delete confirms the exact row and handles pending and empty-list states', async ({ page }) => {
  const ftp = { host: 'ftp.example.test', port: 21, username: 'ftp-user', protocol: 'ftp' };
  const sftp = { host: 'sftp.example.test', port: 22, username: 'ssh-user', protocol: 'sftp' };
  await deliverHostMessage(page, { type: 'data', savedProfiles: [ftp, sftp] });
  const saved = page.getByRole('button', { name: 'Saved connections' });
  await saved.click();
  const savedList = page.getByRole('region', { name: 'Saved connections list' });
  await savedList.getByRole('button', { name: 'Select saved connection ssh-user@sftp.example.test:22 · SFTP' }).click();
  await saved.click();
  const forgetFtp = savedList.getByRole('button', { name: 'Forget saved connection ftp-user@ftp.example.test:21 · FTP' });
  await expect(forgetFtp.locator('.material-symbols-outlined')).toHaveText('delete');
  await forgetFtp.click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('Its saved password will also be removed.');
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel' }).press('Escape');
  await expect(confirmation).toBeHidden();
  expect(await getHostMessages(page, 'forget-connection')).toHaveLength(0);

  await saved.click();
  await savedList.getByRole('button', { name: 'Forget saved connection ftp-user@ftp.example.test:21 · FTP' }).click();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toBeHidden();
  expect(await getHostMessages(page, 'forget-connection')).toHaveLength(0);

  const request = waitForHostMessage(page, 'forget-connection');
  await saved.click();
  await savedList.getByRole('button', { name: 'Forget saved connection ftp-user@ftp.example.test:21 · FTP' }).click();
  await confirmation.getByRole('button', { name: 'Forget connection' }).click();
  expect(await request).toMatchObject({ type: 'forget-connection', profile: ftp });
  await expect(saved).toBeDisabled();
  await deliverHostMessage(page, { type: 'data', savedProfiles: [sftp] });
  await expect(saved).toBeEnabled();
  await saved.click();
  await expect(savedList.locator('.saved-item')).toHaveCount(1);
  await expect(savedList).toContainText('ssh-user@sftp.example.test:22 · SFTP');

  const lastDelete = waitForHostMessage(page, 'forget-connection');
  await savedList.getByRole('button', { name: 'Forget saved connection ssh-user@sftp.example.test:22 · SFTP' }).click();
  await confirmation.getByRole('button', { name: 'Forget connection' }).click();
  expect(await lastDelete).toMatchObject({ type: 'forget-connection', profile: sftp });
  await expect(saved).toBeDisabled();
  await deliverHostMessage(page, { type: 'data', savedProfiles: [] });
  await expect(saved).toBeHidden();

  await deliverHostMessage(page, { type: 'data', savedProfiles: [ftp] });
  await expect(saved).toBeVisible();
  await expect(saved).toHaveAttribute('aria-expanded', 'false');
});

test('connected state disables all connection fields and closes selectors', async ({ page }) => {
  const profile = { host: 'sftp.example.test', port: 22, username: 'tester', protocol: 'sftp' };
  await deliverHostMessage(page, { type: 'data', savedProfiles: [profile], connected: true, profile });
  await expect(page.getByRole('textbox', { name: 'Server' })).toBeDisabled();
  await expect(page.getByLabel('Port')).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeDisabled();
  await expect(page.getByLabel('Password')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Connection protocol' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
});

test('saved-connection and protocol popups close on Escape', async ({ page }) => {
  await deliverHostMessage(page, { type: 'data', savedProfiles: [{ host: 'ftp.example.test', port: 21, username: 'ftp-user', protocol: 'ftp' }] });
  const saved = page.getByRole('button', { name: 'Saved connections' });
  await saved.click();
  await expect(page.getByRole('region', { name: 'Saved connections list' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Saved connections list' })).toBeHidden();

  const protocol = page.getByRole('button', { name: 'Connection protocol' });
  await protocol.click();
  await expect(page.getByRole('region', { name: 'Connection protocol choices' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Connection protocol choices' })).toBeHidden();
});

test('SFTP carries absolute remote paths for mkdir and both copy directions', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Server' }).fill('sftp.example.test');
  await page.getByRole('textbox', { name: 'Username' }).fill('tester');
  await page.getByLabel('Password').fill('test-password');
  await chooseProtocol(page, 'sftp');
  const connection = waitForHostMessage(page, 'connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await connection).toMatchObject({ type: 'connect', profile: { protocol: 'sftp', port: 22 } });
  await deliverHostMessage(page, {
    type: 'data', connected: true, profile: { host: 'sftp.example.test', port: 22, username: 'tester', protocol: 'sftp' },
    remotePath: '/home/tester', remoteEntries: [
      { name: 'folder', path: '/home/tester/folder', kind: 'directory', size: 0 },
      { name: 'remote.bin', path: '/home/tester/remote.bin', kind: 'file', size: 4 }
    ]
  });

  await page.locator('bm-file-pane').nth(1).click();
  const mkdir = waitForHostMessage(page, 'create-folder');
  await page.getByRole('button', { name: 'Mkdir' }).click();
  expect(await mkdir).toMatchObject({ type: 'create-folder', pane: 'remote' });

  const remotePane = page.locator('bm-file-pane').nth(1);
  await remotePane.getByRole('button', { name: /remote\.bin/ }).click();
  const download = waitForHostMessage(page, 'copy');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await download).toMatchObject({ type: 'copy', source: 'remote', paths: ['/home/tester/remote.bin'] });
  await deliverHostMessage(page, { type: 'copy-progress', progress: {
    direction: 'download', name: 'remote.bin', total: 4, transferred: 2, verified: 0,
    totalItems: 1, copiedItems: 0, verifiedItems: 0, phase: 'transfer'
  } });
  await expect(page.getByRole('dialog', { name: 'Downloading from server' })).toBeVisible();
  await deliverHostMessage(page, { type: 'data', transfer: 'SFTP download complete.' });
  await deliverHostMessage(page, { type: 'copy-progress', progress: null });
  await page.locator('bm-file-pane').first().getByRole('button', { name: /alpha\.txt/ }).click();
  const upload = waitForHostMessage(page, 'copy');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await upload).toMatchObject({ type: 'copy', source: 'local', paths: ['/workspace/alpha.txt'] });
  await deliverHostMessage(page, { type: 'copy-progress', progress: {
    direction: 'upload', name: 'alpha.txt', total: 12, transferred: 6, verified: 0,
    totalItems: 1, copiedItems: 0, verifiedItems: 0, phase: 'transfer'
  } });
  await expect(page.getByRole('dialog', { name: 'Uploading to server' })).toBeVisible();
  await deliverHostMessage(page, { type: 'data', transfer: 'SFTP upload complete.' });
  await deliverHostMessage(page, { type: 'copy-progress', progress: null });
});

test('Mkdir is disabled for disconnected FTP and sends the selected pane contract', async ({ page }) => {
  const mkdir = page.getByRole('button', { name: 'Mkdir' });
  await expect(mkdir).toBeEnabled();
  const localRequest = waitForHostMessage(page, 'create-folder');
  await mkdir.click();
  expect(await localRequest).toMatchObject({ type: 'create-folder', pane: 'local' });

  await page.locator('bm-file-pane').nth(1).click();
  await expect(mkdir).toBeDisabled();
  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  await expect(mkdir).toBeEnabled();
  const remoteRequest = waitForHostMessage(page, 'create-folder');
  await mkdir.click();
  expect(await remoteRequest).toMatchObject({ type: 'create-folder', pane: 'remote' });
});

test('single-file copy requests use the active pane and selected path in both directions', async ({ page }) => {
  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  const copyButton = page.getByRole('button', { name: 'Copy', exact: true });

  await page.locator('bm-file-pane').first().getByRole('button', { name: /alpha\.txt/ }).click();
  const upload = waitForHostMessage(page, 'copy');
  await copyButton.click();
  expect(await upload).toMatchObject({ type: 'copy', source: 'local', paths: ['/workspace/alpha.txt'] });
  await deliverHostMessage(page, { type: 'data', transfer: 'Upload fixture complete.' });
  await deliverHostMessage(page, { type: 'copy-progress', progress: null });

  await page.locator('bm-file-pane').nth(1).getByRole('button', { name: /alpha-remote\.txt/ }).click();
  const download = waitForHostMessage(page, 'copy');
  await copyButton.click();
  expect(await download).toMatchObject({ type: 'copy', source: 'remote', paths: ['/alpha-remote.txt'] });
});

test('multi-selection sends mixed file and folder paths without flattening their tree', async ({ page }) => {
  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  const localPane = page.locator('bm-file-pane').first();
  await localPane.getByRole('button', { name: /^Documents/ }).click();
  await localPane.getByRole('button', { name: /alpha\.txt/ }).click({ modifiers: ['Meta'] });

  const upload = waitForHostMessage(page, 'copy');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await upload).toMatchObject({
    type: 'copy', source: 'local', paths: ['/workspace/Documents', '/workspace/alpha.txt']
  });
  await deliverHostMessage(page, { type: 'data', transfer: 'Upload fixture complete.' });
  await deliverHostMessage(page, { type: 'copy-progress', progress: null });

  const remotePane = page.locator('bm-file-pane').nth(1);
  await remotePane.getByRole('button', { name: /^folder/ }).click();
  await remotePane.getByRole('button', { name: /alpha-remote\.txt/ }).click({ modifiers: ['Meta'] });
  const download = waitForHostMessage(page, 'copy');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await download).toMatchObject({
    type: 'copy', source: 'remote', paths: ['/folder', '/alpha-remote.txt']
  });
});

test('copy modal reflects host transfer progress and accepted or cancelled completion', async ({ page }) => {
  await connectMockedFtp(page);
  await markMockFtpConnected(page);
  await page.locator('bm-file-pane').first().getByRole('button', { name: /alpha\.txt/ }).click();
  const copy = waitForHostMessage(page, 'copy');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await copy).toMatchObject({ type: 'copy', source: 'local' });

  await deliverHostMessage(page, {
    type: 'copy-progress', progress: {
      direction: 'upload', name: 'alpha.txt', total: 12, transferred: 6, verified: 0,
      totalItems: 1, copiedItems: 0, verifiedItems: 0, phase: 'transfer'
    }
  });
  const progress = page.getByRole('dialog', { name: 'Uploading to server' });
  await expect(progress.getByRole('progressbar', { name: 'Copied bytes' })).toHaveAttribute('value', '50');
  await deliverHostMessage(page, { type: 'data', transfer: 'Copied 1 item to FTP.' });
  await deliverHostMessage(page, { type: 'copy-progress', progress: null });
  await expect(progress).toBeHidden();
  await expect(page.getByText('Copied 1 item to FTP.')).toBeVisible();

  await deliverHostMessage(page, { type: 'data', transfer: 'Copy cancelled.' });
  await expect(page.getByText('Copy cancelled.')).toBeVisible();
});

test('copy errors show the host error and safe retry guidance', async ({ page }) => {
  await deliverHostMessage(page, { type: 'error', operation: 'copy', error: 'Upload validation failed for test.bin.' });
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Copy failed');
  await expect(dialog).toContainText('Upload validation failed for test.bin.');
  await expect(dialog).toContainText('Check the destination before retrying.');
});
