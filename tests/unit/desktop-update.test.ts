import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi, type Mock } from 'vitest';
import type { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { offerStartupUpdate } from '../../electron/desktop-update.js';

const { check, download, prompt, showError }: { check: Mock; download: Mock; prompt: Mock; showError: Mock } = vi.hoisted(
  (): { check: Mock; download: Mock; prompt: Mock; showError: Mock } => ({ check: vi.fn(), download: vi.fn(), prompt: vi.fn(), showError: vi.fn() })
);

vi.mock('electron', (): object => ({
  app: { isPackaged: true },
  dialog: { showMessageBox: prompt, showErrorBox: showError }
}));

vi.mock('node:fs', async (original: () => Promise<typeof import('node:fs')>): Promise<object> => ({
  ...await original(), existsSync: (): boolean => true
}));

vi.mock('electron-updater', (): object => {
  class BaseUpdater {
    readonly on: Mock = vi.fn();
    readonly netSession: { webRequest: { onBeforeRequest: Mock } } = { webRequest: { onBeforeRequest: vi.fn() } };
    readonly checkForUpdates: Mock = check;
    readonly downloadUpdate: Mock = download;
  }
  return { BaseUpdater, autoUpdater: new BaseUpdater() };
});

const window: BrowserWindow = { isDestroyed: (): boolean => false } as BrowserWindow;
const install: Mock<() => Promise<void>> = vi.fn();

beforeEach((): void => {
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.assign(Object.create(process) as NodeJS.Process, { resourcesPath: 'test-resources' }));
  check.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } });
});

afterEach((): void => {
  vi.unstubAllGlobals();
});

test('does not download an update declined by the user', async (): Promise<void> => {
  prompt.mockResolvedValue({ response: 1 });
  await offerStartupUpdate(window, install);
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(prompt.mock.calls.length, 1);
  assert.equal(download.mock.calls.length, 0);
  assert.equal(install.mock.calls.length, 0);
});

test('downloads an accepted update before handing it to the installer', async (): Promise<void> => {
  prompt.mockResolvedValue({ response: 0 });
  download.mockResolvedValue(['installer.exe']);
  await offerStartupUpdate(window, install);
  assert.equal(download.mock.calls.length, 1);
  assert.equal(install.mock.calls.length, 1);
  assert.ok(download.mock.invocationCallOrder[0] < install.mock.invocationCallOrder[0]);
});

test('keeps startup quiet when the update feed cannot be reached', async (): Promise<void> => {
  check.mockRejectedValue(new Error('offline'));
  await offerStartupUpdate(window, install);
  assert.equal(prompt.mock.calls.length, 0);
  assert.equal(download.mock.calls.length, 0);
  assert.equal(showError.mock.calls.length, 0);
});

test('reports a failed download and leaves the application running', async (): Promise<void> => {
  prompt.mockResolvedValue({ response: 0 });
  download.mockRejectedValue(new Error('download failed'));
  await offerStartupUpdate(window, install);
  assert.equal(showError.mock.calls.length, 1);
  assert.equal(install.mock.calls.length, 0);
});
