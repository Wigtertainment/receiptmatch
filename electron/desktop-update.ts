import { app, dialog, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { autoUpdater, BaseUpdater, type UpdateCheckResult } from 'electron-updater';

const updateHosts: ReadonlySet<string> = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export async function offerStartupUpdate(window: BrowserWindow, install: (updater: BaseUpdater) => Promise<void>): Promise<void> {
  if (!app.isPackaged || process.argv.includes('--hidden') || !existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    return;
  }
  const updater: typeof autoUpdater = autoUpdater;
  if (!(updater instanceof BaseUpdater)) {
    return;
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.on('error', (error: Error): void => console.warn('ReceiptMatch update failed.', error.message));
  updater.netSession.webRequest.onBeforeRequest((details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void): void => {
    const url: URL = new URL(details.url);
    callback({ cancel: url.protocol !== 'https:' || Boolean(url.port || url.username || url.password) || !updateHosts.has(url.hostname) });
  });

  let update: UpdateCheckResult | null;
  try {
    update = await updater.checkForUpdates();
  } catch {
    return;
  }
  if (!update?.isUpdateAvailable || window.isDestroyed()) {
    return;
  }

  const version: string = update.updateInfo.version;
  const choice: Electron.MessageBoxReturnValue = await dialog.showMessageBox(window, {
    type: 'info', title: 'ReceiptMatch update', message: `ReceiptMatch ${version} is available.`,
    detail: 'Download the update and review any unsaved changes before installing.',
    buttons: ['Download and install', 'Later'], defaultId: 0, cancelId: 1, noLink: true
  });
  if (choice.response !== 0 || window.isDestroyed()) {
    return;
  }

  try {
    await updater.downloadUpdate();
    if (!window.isDestroyed()) {
      await install(updater);
    }
  } catch {
    if (!window.isDestroyed()) {
      dialog.showErrorBox('ReceiptMatch update', 'The update could not be downloaded or installed. Please try again after restarting ReceiptMatch.');
    }
  }
}
