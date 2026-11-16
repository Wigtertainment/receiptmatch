import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { expect, test, type ElectronApplication, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { LocalOcrRequest, LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';
import type { OriginalAdoptionResult } from '../../src/shared/original-preview.js';
import type { ReceiptAiPreviewResult } from '../../src/shared/receipt-ai.js';
import type { DocumentFileResult, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';

const receiptName: string = 'nu-extract-receipt.pdf';

async function writeReceipt(directory: string): Promise<void> {
    const pdf: PDFDocument = await PDFDocument.create();
    const page: PDFPage = pdf.addPage([500, 500]);
    const lines: string[] = ['INVOICE', 'Cedar Workshop', 'Invoice number: UI-2047', 'Invoice Date: 2026-10-12', 'Invoice Total: EUR 48.75'];
    for (const [index, text] of lines.entries()) {
        page.drawText(text, { x: 40, y: 450 - index * 30, size: 16 });
    }
    await writeFile(path.join(directory, receiptName), await pdf.save());
}

async function openWorkspace(application: ElectronApplication, folder: string): Promise<Page> {
    await application.evaluate(({ BrowserWindow, dialog }: typeof Electron.CrossProcessExports, folder: string): void => {
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
        dialog.showOpenDialog = (): Promise<{ canceled: boolean; filePaths: string[] }> => Promise.resolve({ canceled: false, filePaths: [folder] });
        dialog.showMessageBox = (): Promise<{ response: number; checkboxChecked: boolean }> => Promise.resolve({ response: 1, checkboxChecked: false });
    }, folder);
    const page: Page = await application.firstWindow({ timeout: 30_000 });
    await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await expect(page.getByText('Analysis finished.', { exact: true })).toBeVisible();
    return page;
}

async function originalReceipt(page: Page): Promise<StoredSupportingDocument> {
    const reports: StoredDocumentImport[] = await page.evaluate((): Promise<StoredDocumentImport[]> => window.receiptmatch.documentImports());
    const file: DocumentFileResult | undefined = reports[0]?.files[0];
    assert.ok(file?.status === 'imported');
    return file.record;
}

async function mockReview(application: ElectronApplication, receipt: StoredSupportingDocument): Promise<void> {
    type Preview = Extract<ReceiptAiPreviewResult, { status: 'ready' }>;
    const result: Preview = {
        status: 'ready', model: 'nuextract3', device: 'gpu', token: randomUUID(), analysis: receipt.result, conflicts: ['Confirm the change in the active analysis.'],
        changes: [
            { label: 'Issue date', before: '2026-10-12', after: '2026-10-13' },
            { label: 'Invoice reference', before: null, after: '5008948439', unrecognized: true }
        ]
    };
    const state: LocalOcrStatus = {
        installed: true, cpuAvailable: true, device: 'cpu', effectiveDevice: 'cpu', modelDownloadBytes: 3459015168, vulkanDownloadBytes: 38023440,
        gpu: 'unchecked', download: null, busy: false, failedDownload: null
    };
    await application.evaluate(({ ipcMain }: typeof Electron.CrossProcessExports, fixture: { result: Preview; state: LocalOcrStatus }): void => {
        ipcMain.removeHandler('app:local-ocr');
        ipcMain.handle('app:local-ocr', (_event: Electron.IpcMainInvokeEvent, request: LocalOcrRequest): LocalOcrStatus => {
            if (request.type === 'select-nuextract-device') {
                fixture.state.device = request.device;
                fixture.state.effectiveDevice = request.device === 'cpu' || fixture.state.gpu === 'available' ? request.device : null;
            }
            return fixture.state;
        });
        ipcMain.removeHandler('workspace:reanalyze-receipt');
        ipcMain.handle('workspace:reanalyze-receipt', (): Preview => {
            fixture.state.gpu = 'available';
            fixture.state.effectiveDevice = 'gpu';
            return fixture.result;
        });
        ipcMain.removeHandler('workspace:discard-receipt-analysis');
        ipcMain.handle('workspace:discard-receipt-analysis', (_event: Electron.IpcMainInvokeEvent, request: { token: string }): void => {
            process.env.RECEIPTMATCH_TEST_DISCARDED = request.token;
        });
        ipcMain.removeHandler('workspace:accept-receipt-analysis');
        ipcMain.handle('workspace:accept-receipt-analysis', (_event: Electron.IpcMainInvokeEvent, request: { token: string; acknowledgeConflicts: boolean }): OriginalAdoptionResult => {
            if (request.token !== fixture.result.token || !request.acknowledgeConflicts) {
                return { status: 'failed', error: 'The review was not acknowledged.' };
            }
            process.env.RECEIPTMATCH_TEST_APPLIED = request.token;
            return { status: 'adopted' };
        });
    }, { result, state });
}

async function chooseGpu(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const devices: Locator = page.getByRole('group', { name: 'NuExtract3 processing device' });
    const cpu: Locator = devices.getByRole('button', { name: 'CPU', exact: true });
    const gpu: Locator = devices.getByRole('button', { name: 'GPU', exact: true });
    await expect(cpu).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Effective device · CPU', { exact: true })).toBeVisible();
    const selectedBackground: string = await cpu.evaluate((button: HTMLElement): string => getComputedStyle(button).backgroundColor);
    await expect(gpu).not.toHaveCSS('background-color', selectedBackground);
    await gpu.click();
    await expect(gpu).toHaveAttribute('aria-pressed', 'true');
    await expect(gpu).toHaveCSS('background-color', selectedBackground);
    await expect(page.getByText('Selected device · GPU', { exact: true })).toBeVisible();
    await expect(page.getByText('Effective device · Pending GPU check', { exact: true })).toBeVisible();
    await cpu.click();
    await expect(cpu).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Effective device · CPU', { exact: true })).toBeVisible();
    await gpu.click();
    await expect(gpu).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
}

async function reviewFor(page: Page, analyze: Locator): Promise<Locator> {
    await analyze.click();
    const review: Locator = page.getByRole('dialog', { name: 'Review AI receipt analysis', exact: true });
    await expect(review).toBeVisible();
    return review;
}

test('keeps unverified NuExtract3 values outside the applicable comparison and awaits confirmation', async ({ playwright }: PlaywrightWorkerArgs): Promise<void> => {
    test.skip(process.platform !== 'win32' || process.env.RECEIPTMATCH_RECEIPT_AI_UI !== '1', 'Opt in with a built Windows desktop app.');
    test.setTimeout(60_000);
    const executablePath: unknown = (await import('electron')).default;
    assert.equal(typeof executablePath, 'string');
    await mkdir(path.resolve('tmp'), { recursive: true });
    const temporary: string = await realpath(path.resolve('tmp'));
    const root: string = await mkdtemp(path.join(temporary, 'receipt-ai-ui-'));
    const folder: string = path.join(root, 'receipts');
    let application: ElectronApplication | undefined;
    try {
        await mkdir(folder);
        await writeReceipt(folder);
        application = await playwright._electron.launch({ executablePath: executablePath as string,
            args: [path.resolve('.'), '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')],
            env: { ...process.env, ELECTRON_START_URL: '', RECEIPTMATCH_TEST_DISCARDED: '', RECEIPTMATCH_TEST_APPLIED: '' }, chromiumSandbox: true, timeout: 30_000 });
        const page: Page = await openWorkspace(application, folder);
        const original: StoredSupportingDocument = await originalReceipt(page);
        const analyze: Locator = page.getByRole('button', { name: 'Analyze with NuExtract3 for ' + receiptName, exact: true });
        await analyze.click();
        await expect(page.getByText(/Download NuExtract3 under Settings/)).toBeVisible();
        await mockReview(application, original);
        await chooseGpu(page);
        const review: Locator = await reviewFor(page, analyze);
        await expect(review.getByText('Analyzed with NuExtract3 on GPU', { exact: true })).toBeVisible();
        await expect(review.getByRole('region', { name: 'Unverified suggestions', exact: true })).toContainText('5008948439');
        await expect(review.getByRole('region', { name: 'Changed', exact: true })).toContainText('2026-10-13');
        await expect(review.getByRole('region', { name: 'Changed', exact: true })).not.toContainText('5008948439');
        await expect(review.getByRole('button', { name: 'Apply AI analysis', exact: true })).toBeDisabled();
        await review.getByRole('button', { name: 'Discard AI analysis', exact: true }).click();
        await expect(review).toHaveCount(0);
        await expect(analyze).toBeFocused();
        assert.ok(await application.evaluate((): string | undefined => process.env.RECEIPTMATCH_TEST_DISCARDED));
        assert.deepEqual(await originalReceipt(page), original);
        const next: Locator = await reviewFor(page, analyze);
        const apply: Locator = next.getByRole('button', { name: 'Apply AI analysis', exact: true });
        await expect(apply).toBeDisabled();
        assert.equal(await application.evaluate((): string | undefined => process.env.RECEIPTMATCH_TEST_APPLIED), '');
        await next.getByRole('checkbox', { name: 'I acknowledge the effects listed above.', exact: true }).check();
        await apply.click();
        await expect(next).toHaveCount(0);
        await expect(page.getByText('AI analysis applied.', { exact: true })).toBeVisible();
        assert.ok(await application.evaluate((): string | undefined => process.env.RECEIPTMATCH_TEST_APPLIED));
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page.getByText('Selected device · GPU', { exact: true })).toBeVisible();
        await expect(page.getByText('Effective device · GPU', { exact: true })).toBeVisible();
    } finally {
        await application?.close();
        assert.ok(path.dirname(await realpath(root)) === temporary && path.basename(root).startsWith('receipt-ai-ui-'));
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
});
