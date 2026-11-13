import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { span } from '../unit/bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank } from '../unit/document-fixtures.js';

async function pdf(pages: string[][]) {
    const file = await PDFDocument.create();
    const font = await file.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
        const page = file.addPage([600, 800]);
        for (const [index, text] of lines.entries()) page.drawText(text, { x: 35, y: 745 - index * 30, size: 18, font });
    }
    return file.save();
}

async function original(root: string, filename: string, format: StoredSupportingDocument['format'], bytes: Uint8Array, lines: string[]): Promise<StoredSupportingDocument> {
    const filePath = path.join(root, filename);
    await writeFile(filePath, bytes);
    const { input } = extractedDocument(bytes, randomUUID(), format);
    input.pages[0].spans = lines.map((line, index) => span(line, 35, 55 + index * 30, 280, format === 'pdf' ? 'embedded-text' : 'local-ocr'));
    return { id: randomUUID(), filePath, format, importedAt: '2032-05-20T12:00:00.000Z', result: interpretSupportingDocument(input) };
}

test('opens local originals independently from statements, documents and match suggestions', async ({ playwright }, testInfo) => {
    test.setTimeout(90000);
    const root = testInfo.outputPath('originals');
    await mkdir(root, { recursive: true });
    const app = await playwright._electron.launch({
        executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
        args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, 'profile')}`],
    });
    try {
        const main = await app.firstWindow();
        const bank = retainedBank(root);
        const bankBytes = await pdf([['Original statement, page one'], ['Original statement, page two']]);
        await writeFile(bank.filePath, bankBytes);
        bank.result.sourceProvenance!.sha256 = createHash('sha256').update(bankBytes).digest('hex');
        const lines = ['Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1,234.56'];
        const receipt = await original(root, 'receipt.pdf', 'pdf', await pdf([lines]), lines);
        const movedReceipt = path.join(root, 'moved-receipt.pdf');
        const movedStatement = path.join(root, 'moved-statement.pdf');
        const changedReceipt = path.join(root, 'changed-receipt.pdf');
        const pictures = await Promise.all((['png', 'jpeg'] as const).map(async format => {
            const base64 = await main.evaluate(value => {
                const canvas = document.createElement('canvas');
                canvas.width = 600; canvas.height = 800;
                const context = canvas.getContext('2d')!;
                context.fillStyle = '#feddae'; context.fillRect(0, 0, canvas.width, canvas.height);
                return canvas.toDataURL(`image/${value}`).split(',')[1];
            }, format);
            return original(root, `receipt.${format}`, format, Buffer.from(base64, 'base64'), ['Receipt', 'Merchant: Corner Cafe']);
        }));
        const workspaceFile = path.join(root, 'preview.receiptmatch');
        await createWorkspace(workspaceFile, newMetadata(), [bank], [documentRun(root, [receipt, ...pictures])]);
        await app.evaluate(({ dialog }, selections) => {
            dialog.showOpenDialog = async () => {
                if (!selections.length) throw new Error('Unexpected file dialog.');
                const filePath = selections.shift();
                return filePath ? { canceled: false, filePaths: [filePath] } : { canceled: true, filePaths: [] };
            };
            dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        }, [workspaceFile, null, changedReceipt, movedReceipt, movedStatement, workspaceFile]);
        await main.getByRole('button', { name: 'Open workspace', exact: false }).click();
        const invalid = await main.evaluate(async () => {
            const payload = { kind: 'statement' as const, id: crypto.randomUUID(), loadRevision: 1, filePath: 'unrelated.pdf' };
            return window.receiptmatch.openOriginal(payload);
        });
        expect(invalid.error).toMatch(/not supported/);
        const openPreview = async (page: Page, name: string) => {
            const [preview] = await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: `Open original ${name}`, exact: true }).click()]);
            await expect.poll(() => preview.url()).toBe('receiptmatch-extraction://preview/index.html');
            return preview;
        };
        const statement = await openPreview(main, path.basename(bank.filePath));
        await expect(statement.getByText('Page 1 of 2', { exact: true })).toBeVisible();
        await expect(statement.locator('canvas')).toBeVisible();
        await statement.getByRole('button', { name: 'Next page' }).click();
        await expect(statement.getByRole('img', { name: 'Page 2 of 2', exact: true })).toBeVisible();
        const independent = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
            .filter(window => window.webContents.getURL() === 'receiptmatch-extraction://preview/index.html')
            .every(window => !window.isModal() && window.getParentWindow() === null && window.isResizable()));
        expect(independent).toBe(true);

        const sources = main.getByRole('region', { name: 'Supporting documents' });
        await sources.getByText(path.basename(root), { exact: true }).click();
        const png = await openPreview(main, 'receipt.png');
        await expect(png.getByRole('img')).toBeVisible();
        await expect.poll(() => png.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(600);
        await main.getByRole('button', { name: 'Match suggestions', exact: true }).click();
        const matches = main.getByRole('region', { name: 'Match suggestions', exact: true });
        await expect(matches.getByRole('heading', { name: 'receipt.pdf' })).toBeVisible();
        const candidate = await openPreview(main, 'receipt.pdf');
        await expect(candidate.locator('canvas')).toBeVisible();
        const picker = matches.getByLabel('Supporting document');
        await picker.selectOption({ label: 'receipt.jpeg' });
        const jpeg = await openPreview(main, 'receipt.jpeg');
        await expect.poll(() => jpeg.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(600);
        await matches.getByRole('button', { name: 'Assign document', exact: true }).click();
        await expect(matches.getByText('Document assigned · receipt.jpeg', { exact: true })).toBeVisible();
        expect(app.windows()).toHaveLength(5);
        await matches.getByRole('button', { name: 'Open original receipt.jpeg', exact: true }).click();
        expect(app.windows()).toHaveLength(5);

        await candidate.close();
        await rename(receipt.filePath, movedReceipt);
        await writeFile(receipt.filePath, await pdf([['Different source']]));
        await matches.getByRole('button', { name: 'Open original receipt.pdf', exact: true }).click();
        await expect(matches.getByRole('alert')).toContainText('has changed');
        await rename(receipt.filePath, changedReceipt);
        await matches.getByRole('button', { name: 'Open original receipt.pdf', exact: true }).click();
        await expect(matches.getByRole('alert')).toContainText('no longer at its imported location');

        const relinkReceipt = matches.getByRole('button', { name: 'Relink original receipt.pdf', exact: true });
        await relinkReceipt.click();
        await expect(relinkReceipt).not.toHaveAttribute('aria-busy', 'true');
        await expect(matches.getByRole('alert')).toContainText('no longer at its imported location');
        await relinkReceipt.click();
        await expect(matches.getByRole('alert')).toContainText('The selected file differs from the imported original.');
        await relinkReceipt.click();
        await expect(matches.getByText('Original relinked. You can open it again.', { exact: true })).toBeVisible();
        await expect(matches.getByRole('button', { name: 'Open original receipt.pdf', exact: true })).toBeFocused();
        const relocatedReceipt = await openPreview(main, 'receipt.pdf');
        await expect(relocatedReceipt.locator('canvas')).toBeVisible();
        await expect.poll(() => relocatedReceipt.title()).toContain(path.basename(movedReceipt));

        await statement.close();
        await rename(bank.filePath, movedStatement);
        await main.getByRole('button', { name: 'Sources', exact: true }).click();
        const statements = main.getByRole('region', { name: 'Bank statements', exact: true });
        const statementName = path.basename(bank.filePath);
        await statements.getByRole('button', { name: `Open original ${statementName}`, exact: true }).click();
        await expect(statements.getByRole('alert')).toContainText('no longer at its imported location');
        await statements.getByRole('button', { name: `Relink original ${statementName}`, exact: true }).click();
        await expect(statements.getByText('Original relinked. You can open it again.', { exact: true })).toBeVisible();
        const relocatedStatement = await openPreview(main, statementName);
        await expect(relocatedStatement.getByText('Page 1 of 2', { exact: true })).toBeVisible();
        await expect.poll(() => relocatedStatement.title()).toContain(path.basename(movedStatement));
        await main.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(main.getByText('All changes saved', { exact: true })).toBeVisible();
        await main.getByRole('button', { name: 'New', exact: true }).click();
        await expect.poll(() => app.windows().length).toBe(1);
        await main.getByRole('button', { name: 'Open', exact: true }).click();
        const reopenedStatement = await openPreview(main, statementName);
        await expect(reopenedStatement.getByText('Page 1 of 2', { exact: true })).toBeVisible();
        await expect.poll(() => reopenedStatement.title()).toContain(path.basename(movedStatement));
        await main.getByRole('button', { name: 'Match suggestions', exact: true }).click();
        await expect(matches.getByText('Document assigned · receipt.jpeg', { exact: true })).toBeVisible();
        const reopenedReceipt = await openPreview(main, 'receipt.pdf');
        await expect(reopenedReceipt.locator('canvas')).toBeVisible();
        await expect.poll(() => reopenedReceipt.title()).toContain(path.basename(movedReceipt));
    } finally { await app.close(); }
});
