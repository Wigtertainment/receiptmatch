import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { expect, test, type ElectronApplication, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';
import type { OriginalAdoptionResult } from '../../src/shared/original-preview.js';
import type { ReceiptAiField, ReceiptAiPreviewResult } from '../../src/shared/receipt-ai.js';
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
        status: 'ready', model: 'nuextract3', token: randomUUID(), analysis: receipt.result, conflicts: ['Confirm the change in the active analysis.'],
        changes: [],
        proposals: [
            { field: 'reference', label: 'Invoice reference', before: 'UI-2047', value: '5008948439', verified: false },
            { field: 'issue-date', label: 'Issue date', before: '2026-10-12', value: '2026-10-13', verified: false },
            { field: 'billed-total', label: 'Billed total', before: '48.75 EUR', value: '97.3', verified: false, needsCurrency: true }
        ]
    };
    const state: LocalOcrStatus = {
        installed: true, cpuAvailable: true, device: 'cpu', modelDownloadBytes: 3459015168, vulkanDownloadBytes: 38023440,
        gpu: 'unchecked', download: null, busy: false, failedDownload: null
    };
    await application.evaluate(({ ipcMain }: typeof Electron.CrossProcessExports, fixture: { result: Preview; state: LocalOcrStatus }): void => {
        ipcMain.removeHandler('app:local-ocr');
        ipcMain.handle('app:local-ocr', (): LocalOcrStatus => fixture.state);
        ipcMain.removeHandler('workspace:reanalyze-receipt');
        ipcMain.handle('workspace:reanalyze-receipt', (): Preview => fixture.result);
        ipcMain.removeHandler('workspace:discard-receipt-analysis');
        ipcMain.handle('workspace:discard-receipt-analysis', (_event: Electron.IpcMainInvokeEvent, request: { token: string }): void => {
            process.env.RECEIPTMATCH_TEST_DISCARDED = request.token;
        });
        ipcMain.removeHandler('workspace:accept-receipt-analysis');
        ipcMain.handle('workspace:accept-receipt-analysis', (_event: Electron.IpcMainInvokeEvent,
            request: { token: string; acknowledgeConflicts: boolean; selectedFields: ReceiptAiField[]; currency?: string }): OriginalAdoptionResult => {
            if (request.token !== fixture.result.token || !request.acknowledgeConflicts) {
                return { status: 'failed', error: 'The review was not acknowledged.' };
            }
            process.env.RECEIPTMATCH_TEST_APPLIED = JSON.stringify({ selectedFields: request.selectedFields, currency: request.currency });
            return { status: 'adopted' };
        });
    }, { result, state });
}

async function reviewFor(page: Page, analyze: Locator): Promise<Locator> {
    await analyze.click();
    const review: Locator = page.getByRole('dialog', { name: 'Review AI receipt analysis', exact: true });
    await expect(review).toBeVisible();
    return review;
}

test('applies only selected AI suggestions and keeps the receipt intact on discard', async ({ playwright }: PlaywrightWorkerArgs): Promise<void> => {
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
        const review: Locator = await reviewFor(page, analyze);
        await expect(review.getByText('Analyzed with NuExtract3', { exact: true })).toBeVisible();
        const suggestions: Locator = review.getByRole('region', { name: 'Choose values to apply', exact: true });
        await expect(suggestions.getByRole('button', { name: 'Open original ' + receiptName, exact: true })).toBeVisible();
        await expect(suggestions).toContainText('Current · UI-2047');
        await expect(suggestions).toContainText('Suggested · 5008948439');
        await expect(suggestions.getByText('Needs your confirmation', { exact: true })).toHaveCount(3);
        await expect(review.getByRole('button', { name: 'Apply (0)', exact: true })).toBeDisabled();
        await review.getByRole('checkbox', { name: 'Select Issue date', exact: true }).press('Space');
        await expect(review.getByRole('status').filter({ hasText: '1 selected' })).toBeVisible();
        await review.getByRole('button', { name: 'Discard AI analysis', exact: true }).click();
        await expect(review).toHaveCount(0);
        await expect(analyze).toBeFocused();
        assert.ok(await application.evaluate((): string | undefined => process.env.RECEIPTMATCH_TEST_DISCARDED));
        assert.deepEqual(await originalReceipt(page), original);
        const next: Locator = await reviewFor(page, analyze);
        await expect(next.getByRole('button', { name: 'Apply (0)', exact: true })).toBeDisabled();
        const date: Locator = next.getByRole('checkbox', { name: 'Select Issue date', exact: true });
        await expect(date).not.toBeChecked();
        await next.getByRole('checkbox', { name: 'Select Invoice reference', exact: true }).check();
        await next.getByRole('checkbox', { name: 'Select Billed total', exact: true }).check();
        const apply: Locator = next.getByRole('button', { name: 'Apply (2)', exact: true });
        const currency: Locator = next.getByRole('textbox', { name: 'Currency code for billed total', exact: true });
        assert.equal(await application.evaluate((): string | undefined => process.env.RECEIPTMATCH_TEST_APPLIED), '');
        await next.getByRole('checkbox', { name: 'I acknowledge the effects listed above.', exact: true }).check();
        await expect(apply).toBeDisabled();
        await currency.fill('eu');
        await expect(apply).toBeDisabled();
        await currency.fill('eur');
        await expect(currency).toHaveValue('eur');
        await expect(apply).toBeEnabled();
        await expect(date).not.toBeChecked();
        await apply.click();
        await expect(next).toHaveCount(0);
        await expect(page.getByText('Applied 2 AI suggestions.', { exact: true })).toBeVisible();
        assert.equal(await application.evaluate((): string | undefined => process.env.RECEIPTMATCH_TEST_APPLIED), JSON.stringify({ selectedFields: ['reference', 'billed-total'], currency: 'EUR' }));
    } finally {
        await application?.close();
        assert.ok(path.dirname(await realpath(root)) === temporary && path.basename(root).startsWith('receipt-ai-ui-'));
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
});
