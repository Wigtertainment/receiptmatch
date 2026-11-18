import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page, type TestInfo, type PlaywrightTestArgs, type PlaywrightTestOptions,
    type PlaywrightWorkerArgs, type PlaywrightWorkerOptions } from '@playwright/test';
import { prepareStatementAnalysisVersion } from '../../electron/import/statement-analyses.js';
import { createWorkspace, newMetadata, saveWorkspace, type SavedWorkspace } from '../../electron/store.js';
import type { BankImportResult } from '../../src/shared/bank-import.js';
import type { StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { retainedBank } from '../unit/document-fixtures.js';

test('displays the latest saved statement analysis after opening and reopening the workspace', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
    test.setTimeout(60_000);
    const root: string = testInfo.outputPath('statement-versions');
    await mkdir(root, { recursive: true });
    const file: string = path.join(root, 'workspace.receiptmatch');
    const original: StoredBankImport = retainedBank(root);
    const other: StoredBankImport = retainedBank(root);
    other.filePath = path.join(root, 'overlap.pdf');
    const proposed: BankImportResult = structuredClone(original.result);
    proposed.adapter = null;
    proposed.localRecognition = { model: 'nuextract3', parserVersion: '1' };
    proposed.transactions[0].bookingDate.value = '2032-03-05';
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposed);
    const initial: SavedWorkspace = await createWorkspace(file, newMetadata(), [original, other]);
    await saveWorkspace(initial, initial.metadata, initial.imports, initial.documentImports, initial.matchDecisions, initial.bankCorrections,
        initial.documentCorrections, initial.reviewApprovals, initial.duplicateDecisions, initial.sourceRelocations, initial.sourceReplacements,
        initial.archivedSourceReviews, initial.ignoredTransactions, initial.receiptAnalysisVersions, new Set(), [version]);
    const executablePath: unknown = (await import('electron')).default;
    if (typeof executablePath !== 'string') {
        throw new Error('Electron is unavailable.');
    }
    for (let launch: number = 0; launch < 2; launch++) {
        const app: ElectronApplication = await playwright._electron.launch({ executablePath,
            args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')], env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true });
        try {
            await app.evaluate(({ dialog, BrowserWindow }: typeof Electron.CrossProcessExports, file: string): void => {
                BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
                dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[] }> => Promise.resolve({ canceled: false, filePaths: [file] });
                dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false }> => Promise.resolve({ response: 1, checkboxChecked: false });
            }, file);
            const page: Page = await app.firstWindow();
            await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
            await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Sources', exact: true }).click();
            const panel: Locator = page.getByRole('region', { name: 'Bank statements', exact: true });
            await expect(panel.getByText('2 statements', { exact: true })).toBeVisible();
            await expect(panel.getByText('Local AI · NuExtract3', { exact: true })).toBeVisible();
            const expectedDate: string = await page.evaluate((value: string): string => new Intl.DateTimeFormat(undefined,
                { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00.000Z')), '2032-03-05');
            await expect(panel.getByRole('row', { name: /Orchard Workshop/ })).toContainText(expectedDate);
            await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
        } finally {
            await app.close();
        }
    }
});
