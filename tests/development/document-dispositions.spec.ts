import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page, type TestInfo, type PlaywrightTestArgs, type PlaywrightTestOptions,
    type PlaywrightWorkerArgs, type PlaywrightWorkerOptions } from '@playwright/test';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import type { BankImportInput, PositionedSpan } from '../../src/shared/bank-import.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

test('excludes uncertain recognitions, distinguishes notes and persists reversible decisions in both views', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
    test.setTimeout(150_000);
    const root: string = testInfo.outputPath('disposition-workspace');
    await mkdir(root, { recursive: true });
    const workspaceFile: string = path.join(root, 'decisions.receiptmatch');
    const receipt: StoredSupportingDocument = retainedDocument(root, 'decisions.pdf');
    const input: BankImportInput = receipt.result.input!;
    const lines: string[] = ['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1234.56', 'Tax: $1.00'];
    input.pages[0].spans = lines.map((text: string, index: number): PositionedSpan => ({
        text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text',
    }));
    receipt.result = interpretSupportingDocument(input);
    await createWorkspace(workspaceFile, newMetadata(), [retainedBank(root)], [documentRun(root, [receipt])]);
    const executablePath: unknown = (await import('electron')).default;
    if (typeof executablePath !== 'string') {
        throw new Error('Electron is unavailable.');
    }
    let app: ElectronApplication | undefined;
    let page!: Page;

    async function launch(): Promise<void> {
        app = await playwright._electron.launch({ executablePath: executablePath as string,
            args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')], env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true });
        await app.evaluate(({ dialog, BrowserWindow }: typeof Electron.CrossProcessExports, file: string): void => {
            BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
            dialog.showOpenDialog = async (): Promise<Electron.OpenDialogReturnValue> => Promise.resolve({ canceled: false, filePaths: [file] });
            dialog.showMessageBox = async (): Promise<Electron.MessageBoxReturnValue> => Promise.resolve({ response: 1, checkboxChecked: false });
        }, workspaceFile);
        page = await app.firstWindow();
        await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    }

    async function openDocument(): Promise<Locator> {
        await page.getByRole('region', { name: 'Supporting documents' }).getByRole('button', { name: 'Show details for decisions.pdf', exact: true }).click();
        const drawer: Locator = page.getByRole('dialog', { name: 'decisions.pdf', exact: true });
        await expect(drawer).toBeVisible();
        return drawer;
    }

    async function openField(scope: Locator, role: string): Promise<Locator> {
        const field: Locator = scope.locator('.document-field').filter({ has: page.getByText(role, { exact: true }) });
        if (await field.getAttribute('open') === null) {
            await field.locator(':scope > summary').press('Enter');
        }
        await expect(field.locator('.field-body')).toBeVisible();
        return field;
    }

    try {
        await launch();
        const sourceRow: Locator = page.getByRole('region', { name: 'Supporting documents' }).getByRole('row').filter({ has: page.getByRole('button', { name: 'Show details for decisions.pdf', exact: true }) });
        await expect(sourceRow.locator('.source-status')).toHaveText('Imported');
        let drawer: Locator = await openDocument();
        const tax: Locator = await openField(drawer, 'Tax');
        await expect(tax.locator('.field-decision-status')).toHaveText('Information');
        await expect(tax.locator('.field-warning')).toHaveCount(0);
        await expect(tax.locator('.field-notes')).toContainText('ISO currency');
        await tax.getByRole('button', { name: 'Incorrect recognition', exact: true }).press('Enter');
        await expect(tax.locator('.field-value')).toHaveText('Excluded from matching');
        await expect(tax.getByRole('button', { name: 'Reset decision', exact: true })).toBeFocused();
        await expect(tax.locator('.field-warning')).toHaveCount(0);
        await expect(tax.locator('.field-original')).toContainText('Value before decision');
        await tax.getByRole('button', { name: 'Reset decision', exact: true }).press('Enter');
        await expect(tax.locator('.field-decision-status')).toHaveText('Information');
        await expect(tax.getByRole('button', { name: 'Incorrect recognition', exact: true })).toBeFocused();
        const total: Locator = await openField(drawer, 'Billed total');
        await total.getByRole('button', { name: 'Not determinable', exact: true }).press('Enter');
        await expect(total.locator('.field-decision-status')).toHaveText('Not determinable');
        await expect(total.locator('.field-warning')).toHaveText('Unresolved');
        await expect(total.getByRole('button', { name: 'Confirm value', exact: true })).toHaveCount(0);
        await expect(total.locator('.field-original')).toContainText('EUR');
        await total.getByRole('button', { name: 'Reset decision', exact: true }).press('Enter');
        await expect(total.locator('.field-value')).toContainText('EUR');
        const merchant: Locator = await openField(drawer, 'Merchant');
        await merchant.getByRole('button', { name: 'Incorrect recognition', exact: true }).press('Enter');
        await expect(merchant.locator('.field-value')).toHaveText('Excluded from matching');
        await expect(merchant.locator('.field-original')).toContainText('Orchard Workshop');
        await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
        await app!.close();
        app = undefined;
        await launch();
        drawer = await openDocument();
        const restored: Locator = await openField(drawer, 'Merchant');
        await expect(restored.locator('.field-value')).toHaveText('Excluded from matching');
        await expect(restored.locator('.field-warning')).toHaveText('Unresolved');
        await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
        await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Match suggestions', exact: true }).click();
        const manual: Locator = page.getByRole('region', { name: 'Manual review' });
        await manual.getByRole('combobox', { name: 'Supporting document', exact: true }).click();
        await page.getByRole('option', { name: /^decisions\.pdf/ }).click();
        await manual.getByRole('button', { name: 'Document details for decisions.pdf', exact: true }).press('Enter');
        const matchMerchant: Locator = await openField(manual, 'Merchant');
        await expect(matchMerchant.locator('.field-value')).toHaveText('Excluded from matching');
        await matchMerchant.getByRole('button', { name: 'Reset decision', exact: true }).press('Enter');
        await expect(matchMerchant.locator('.field-value')).toHaveText('Orchard Workshop');
        await expect(matchMerchant.getByRole('button', { name: 'Incorrect recognition', exact: true })).toBeFocused();
        await matchMerchant.getByRole('button', { name: 'Confirm value', exact: true }).press('Enter');
        await expect(manual.locator('app-document-analysis > .sr-only[role="status"]')).toHaveText('Field value confirmed.');
    } finally {
        await app?.close();
    }
});
