import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page, type PlaywrightTestArgs, type PlaywrightWorkerArgs } from '@playwright/test';
import type { LocalOcrRequest, LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';

async function mockDeviceSettings(application: ElectronApplication): Promise<void> {
    await application.evaluate(({ ipcMain }: typeof Electron.CrossProcessExports): void => {
        const status: LocalOcrStatus = {
            selection: 'paddleocr-vl-1.6', device: 'cpu', download: null, failedDownload: null,
            models: [{ model: 'paddleocr-vl-1.6', name: 'PaddleOCR-VL 1.6', downloadBytes: 1, installed: true, runtimeAvailable: true, gpuSupported: true }],
            gpu: { state: 'download-required', cancellableCheck: false, downloadBytes: 38_023_440, download: null, failedDownload: false }
        };
        let finishCheck: ((successful: boolean) => void) | undefined;
        let checks: number = 0;
        ipcMain.removeHandler('app:local-ocr');
        ipcMain.handle('app:local-ocr', async (_event: Electron.IpcMainInvokeEvent, request: LocalOcrRequest): Promise<LocalOcrStatus> => {
            switch (request.type) {
                case 'install-gpu-runtime':
                    status.gpu.state = 'unchecked';
                    break;
                case 'check-gpu': {
                    status.gpu.state = 'checking';
                    status.gpu.cancellableCheck = true;
                    const successful: boolean = ++checks > 1 || await new Promise<boolean>((resolve: (value: boolean) => void): void => {
                        finishCheck = resolve;
                    });
                    status.gpu.state = successful ? 'available' : 'unchecked';
                    status.gpu.cancellableCheck = false;
                    if (!successful) {
                        throw new Error('GPU check cancelled.');
                    }
                    break;
                }
                case 'cancel':
                    finishCheck?.(false);
                    finishCheck = undefined;
                    break;
                case 'select-device':
                    status.device = request.device;
                    if (request.device === 'gpu') {
                        status.gpu.state = 'unavailable';
                        status.gpu.issue = 'Test GPU became unavailable.';
                    }
                    break;
            }
            return structuredClone(status);
        });
    });
}

test('sets the OCR device after a GPU check and can switch back when the GPU becomes unavailable', async ({ playwright }: PlaywrightTestArgs & PlaywrightWorkerArgs): Promise<void> => {
    await mkdir('artifacts', { recursive: true });
    const profile: string = await mkdtemp(path.resolve('artifacts/local-ocr-device-ui-'));
    let application: ElectronApplication | undefined;
    try {
        const executablePath: string = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');
        application = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', `--user-data-dir=${profile}`] });
        const page: Page = await application.firstWindow();
        await expect(page.getByRole('heading', { name: 'ReceiptMatch', exact: true })).toBeVisible();
        await mockDeviceSettings(application);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const group: Locator = page.getByRole('group', { name: 'AI processing device' });
        const cpu: Locator = group.getByRole('button', { name: 'CPU', exact: true });
        const gpu: Locator = group.getByRole('button', { name: 'GPU', exact: true });
        await expect(cpu).toHaveAttribute('aria-pressed', 'true');
        await expect(gpu).toBeDisabled();
        await page.getByRole('button', { name: 'Download Vulkan runtime' }).click();
        const check: Locator = page.getByRole('button', { name: 'Check GPU', exact: true });
        await check.click();
        await expect(gpu).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Cancel GPU check' })).toBeVisible();
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Cancel GPU check' }).click();
        await expect(check).toBeEnabled();
        await expect(page.getByText('The GPU check could not complete. Try again.')).toHaveCount(0);
        await expect(cpu).toHaveAttribute('aria-pressed', 'true');
        await check.click();
        await expect(gpu).toBeEnabled();
        await gpu.click();
        await expect(gpu).toHaveAttribute('aria-pressed', 'true');
        await expect(gpu).toBeDisabled();
        await expect(page.getByText('Test GPU became unavailable.', { exact: true })).toBeVisible();
        await cpu.click();
        await expect(cpu).toHaveAttribute('aria-pressed', 'true');
    } finally {
        await application?.close();
        await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
});
