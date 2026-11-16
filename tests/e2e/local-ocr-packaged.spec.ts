import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { expect, test, type ElectronApplication, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';
import type { WorkspaceState } from '../../src/shared/protocol.js';
import type { DocumentFileResult, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';

const legacyVersion: string = 'pdfjs-6.5.438+paddleocr-vl-1.6-gguf-spotting+document-2';

async function createReceipt(directory: string): Promise<void> {
    const document: PDFDocument = await PDFDocument.create();
    const page: PDFPage = document.addPage([500, 500]);
    const lines: string[] = ['INVOICE', 'Cedar Workshop', 'Invoice number: LEGACY-2047', 'Invoice Date: 2026-10-12', 'Invoice Total: EUR 48.75'];
    for (const [index, line] of lines.entries()) {
        page.drawText(line, { x: 40, y: 450 - index * 30, size: 16 });
    }
    await writeFile(path.join(directory, 'prior-receipt.pdf'), await document.save());
}

function addLegacyAnalysis(workspace: string, record: StoredSupportingDocument): string {
    const analysis: StoredSupportingDocument['result'] = structuredClone(record.result);
    assert.ok(analysis.input);
    const runId: string = randomUUID();
    analysis.input.extraction = { runId, version: legacyVersion };
    for (const page of analysis.input.pages) {
        for (const span of page.spans) {
            span.method = 'local-ocr';
        }
    }
    const database: Database.Database = new Database(workspace, { fileMustExist: true });
    try {
        database.prepare('INSERT INTO receipt_analysis_versions(run_id,document_id,record_json) VALUES(?,?,?)')
            .run(runId, record.id, JSON.stringify({ documentId: record.id, acceptedAt: '2026-10-13T08:00:00.000Z', analysis }));
    } finally {
        database.close();
    }
    return runId;
}

async function importedReceipt(page: Page): Promise<StoredSupportingDocument> {
    const reports: StoredDocumentImport[] = await page.evaluate((): Promise<StoredDocumentImport[]> => window.receiptmatch.documentImports());
    const file: DocumentFileResult | undefined = reports[0]?.files[0];
    assert.ok(file?.status === 'imported');
    return file.record;
}

async function verifyRecognitionSettings(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Standard OCR', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'NuExtract3', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download NuExtract3', exact: true })).toBeEnabled();
    await expect(page.getByText(/PP-OCRv6|PaddleOCR/i)).toHaveCount(0);
    const status: LocalOcrStatus = await page.evaluate((): Promise<LocalOcrStatus> => window.receiptmatch.localOcr({ type: 'status' }));
    assert.equal(status.device, 'cpu');
    assert.equal(status.installed, false);
    assert.equal(status.cpuAvailable, true);
}

async function verifyResources(application: ElectronApplication): Promise<void> {
    const resources: { server: boolean; python: boolean; oldCli: boolean; oldScript: boolean } = await application.evaluate((): { server: boolean; python: boolean; oldCli: boolean; oldScript: boolean } => {
        const fs: typeof import('node:fs') = process.getBuiltinModule('node:fs');
        const paths: typeof import('node:path') = process.getBuiltinModule('node:path');
        const installed: string = paths.join(process.resourcesPath, 'local-ocr-runtimes');
        const exe: string = process.platform === 'win32' ? '.exe' : '';
        return {
            server: fs.existsSync(paths.join(installed, 'llama', 'llama-server' + exe)),
            python: fs.existsSync(paths.join(installed, 'python')),
            oldCli: fs.existsSync(paths.join(installed, 'llama', 'llama-mtmd-cli' + exe)),
            oldScript: fs.existsSync(paths.join(process.resourcesPath, 'app.asar', '.build', 'extraction', 'paddle-medium.py'))
        };
    });
    assert.deepEqual(resources, { server: true, python: false, oldCli: false, oldScript: false });
}

async function dialogs(application: ElectronApplication, folder: string, workspace: string): Promise<void> {
    await application.evaluate(({ BrowserWindow, dialog }: typeof Electron.CrossProcessExports, config: { folder: string; workspace: string }): void => {
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
        dialog.showOpenDialog = (_window: Electron.BaseWindow | Electron.OpenDialogOptions, options?: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> => {
            return Promise.resolve({ canceled: false, filePaths: [options?.properties?.includes('openDirectory') ? config.folder : config.workspace] });
        };
        dialog.showSaveDialog = (): Promise<Electron.SaveDialogReturnValue> => Promise.resolve({ canceled: false, filePath: config.workspace });
        dialog.showMessageBox = (): Promise<Electron.MessageBoxReturnValue> => Promise.resolve({ response: 1, checkboxChecked: false });
    }, { folder, workspace });
}

test('packaged recognition opens fresh and legacy profiles with Standard and optional NuExtract3', async ({ playwright }: PlaywrightWorkerArgs): Promise<void> => {
    test.skip(process.env.RECEIPTMATCH_NUEXTRACT_PACKAGE_TEST !== '1', 'Requires an unpacked desktop package.');
    test.setTimeout(150_000);
    await mkdir('artifacts', { recursive: true });
    const root: string = await mkdtemp(path.resolve('artifacts/nuextract-package-'));
    const freshProfile: string = path.join(root, 'fresh');
    const legacyProfile: string = path.join(root, 'legacy');
    const workspace: string = path.join(root, 'prior.receiptmatch');
    const folder: string = path.join(root, 'receipts');
    const executablePath: string = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');
    try {
        await mkdir(folder);
        await createReceipt(folder);
        const fresh: ElectronApplication = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + freshProfile], timeout: 30_000 });
        let oldReceipt: StoredSupportingDocument;
        try {
            const page: Page = await fresh.firstWindow({ timeout: 30_000 });
            await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
            await verifyResources(fresh);
            await dialogs(fresh, folder, workspace);
            await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'new' }));
            await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'import-documents' }));
            oldReceipt = await importedReceipt(page);
            assert.match(oldReceipt.result.input!.extraction.version, /tesseract/);
            const saved: WorkspaceState = await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'save' }));
            assert.equal(saved.workspace?.filePath, workspace);
            await verifyRecognitionSettings(page);
        } finally {
            await fresh.close();
        }

        const runId: string = addLegacyAnalysis(workspace, oldReceipt);
        const legacySettings: string = path.join(legacyProfile, 'local-ocr');
        await mkdir(legacySettings, { recursive: true });
        const selection: string = path.join(legacySettings, 'selection.json');
        await writeFile(selection, '"paddleocr-vl-1.6"');
        const legacy: ElectronApplication = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + legacyProfile], timeout: 30_000 });
        try {
            const page: Page = await legacy.firstWindow({ timeout: 30_000 });
            await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
            assert.equal(await readFile(selection, 'utf8'), '"standard"');
            await dialogs(legacy, folder, workspace);
            await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'open' }));
            const saved: StoredSupportingDocument = await importedReceipt(page);
            assert.equal(saved.id, oldReceipt.id);
            assert.deepEqual(saved.result.input?.extraction, { runId, version: legacyVersion });
            await verifyRecognitionSettings(page);
        } finally {
            await legacy.close();
        }
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 4 });
    }
});
