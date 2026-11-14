import type { BankImportInput, PositionedSpan } from "../../src/shared/bank-import.js";
import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { OriginalPreviewResult } from "../../src/shared/original-preview.js";
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type ElectronApplication, type Page, type TestInfo, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs } from '@playwright/test';
import { PDFDocument, StandardFonts, type PDFPage, type PDFFont } from 'pdf-lib';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { span } from '../unit/bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank } from '../unit/document-fixtures.js';

async function pdf(pages: string[][]): Promise<Uint8Array<ArrayBufferLike>> {
    const file: PDFDocument = await PDFDocument.create();
    const font: PDFFont = await file.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
        const page: PDFPage = file.addPage([600, 800]);
        for (const [index, text] of lines.entries()) {
            page.drawText(text, { x: 35, y: 745 - index * 30, size: 18, font });
        }
    }
    return file.save();
}

async function original(root: string, filename: string, format: StoredSupportingDocument['format'], bytes: Uint8Array, lines: string[]): Promise<StoredSupportingDocument> {
    const filePath: string = path.join(root, filename);
    await writeFile(filePath, bytes);
    const { input }: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(bytes, randomUUID(), format);
    input.pages[0].spans = lines.map((line: string, index: number): PositionedSpan => span(line, 35, 55 + index * 30, 280, format === 'pdf' ? 'embedded-text' : 'local-ocr'));
    return { id: randomUUID(), filePath, format, importedAt: '2032-05-20T12:00:00.000Z', result: interpretSupportingDocument(input) };
}

test('opens local originals independently from statements, documents and match suggestions', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
    test.setTimeout(120000);
    const root: string = testInfo.outputPath('originals');
    await mkdir(root, { recursive: true });
    const app: ElectronApplication = await playwright._electron.launch({
        executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
        args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, 'profile')}`],
    });
    try {
        const main: Page = await app.firstWindow();
        const bank: StoredBankImport = retainedBank(root);
        const bankBytes: Uint8Array<ArrayBufferLike> = await pdf([['Original statement, page one'], ['Original statement, page two']]);
        await writeFile(bank.filePath, bankBytes);
        bank.result.sourceProvenance!.sha256 = createHash('sha256').update(bankBytes).digest('hex');
        const lines: string[] = ['Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1,234.56'];
        const receipt: StoredSupportingDocument = await original(root, 'receipt.pdf', 'pdf', await pdf([lines]), lines);
        const movedReceipt: string = path.join(root, 'moved-receipt.pdf');
        const movedPng: string = path.join(root, 'moved-receipt.png');
        const movedStatement: string = path.join(root, 'moved-statement.pdf');
        const changedReceipt: string = path.join(root, 'changed-receipt.pdf');
        const pictures: StoredSupportingDocument[] = await Promise.all((['png', 'jpeg'] as const).map(async (format: "png" | "jpeg"): Promise<StoredSupportingDocument> => {
            const base64: string = await main.evaluate((value: "png" | "jpeg"): string => {
                const canvas: HTMLCanvasElement = document.createElement('canvas');
                canvas.width = 600; canvas.height = 800;
                const context: CanvasRenderingContext2D = canvas.getContext('2d')!;
                context.fillStyle = '#feddae'; context.fillRect(0, 0, canvas.width, canvas.height);
                return canvas.toDataURL(`image/${value}`).split(',')[1];
            }, format);
            return original(root, `receipt.${format}`, format, Buffer.from(base64, 'base64'), ['Receipt', 'Merchant: Corner Cafe']);
        }));
        const workspaceFile: string = path.join(root, 'preview.receiptmatch');
        await createWorkspace(workspaceFile, newMetadata(), [bank], [documentRun(root, [receipt, ...pictures])]);
        await app.evaluate(({ dialog }: typeof Electron.CrossProcessExports, selections: (string | null)[]): void => {
            dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[]; } | { canceled: true; filePaths: never[]; }> => {
                if (!selections.length) {
                    throw new Error('Unexpected file dialog.');
                }
                const filePath: string | null | undefined = selections.shift();
                return Promise.resolve(filePath ? { canceled: false, filePaths: [filePath] } : { canceled: true, filePaths: [] });
            };
            dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: 1, checkboxChecked: false }));
        }, [workspaceFile, movedPng, null, changedReceipt, movedReceipt, movedStatement, workspaceFile]);
        await main.getByRole('button', { name: 'Open workspace', exact: false }).click();
        const invalid: OriginalPreviewResult = await main.evaluate(async (): Promise<OriginalPreviewResult> => {
            const payload: { kind: "statement"; id: `${string}-${string}-${string}-${string}-${string}`; loadRevision: number; filePath: string; } = { kind: 'statement' as const, id: crypto.randomUUID(), loadRevision: 1, filePath: 'unrelated.pdf' };
            return window.receiptmatch.openOriginal(payload);
        });
        expect(invalid.error).toMatch(/not supported/);
        const openPreview: (page: Page, name: string) => Promise<Page> = async (page: Page, name: string): Promise<Page> => {
            const [preview]: [Page, void] = await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: `Open original ${name}`, exact: true }).click()]);
            await expect.poll((): string => preview.url()).toBe('receiptmatch-extraction://preview/index.html');
            return preview;
        };
        const statement: Page = await openPreview(main, path.basename(bank.filePath));
        await expect(statement.getByText('Page 1 of 2', { exact: true })).toBeVisible();
        await expect(statement.locator('canvas')).toBeVisible();
        const previous: Locator = statement.locator('wig-button').getByRole('button', { name: 'Previous page' });
        const next: Locator = statement.locator('wig-button').getByRole('button', { name: 'Next page' });
        await expect(previous).toBeDisabled();
        await expect(next).toHaveCSS('align-items', 'center');
        await next.press('Enter');
        await expect(statement.getByRole('img', { name: 'Page 2 of 2', exact: true })).toBeVisible();
        await expect(next).toBeDisabled();
        await previous.press('Enter');
        await expect(statement.getByRole('img', { name: 'Page 1 of 2', exact: true })).toBeVisible();
        async function wheelZoom(preview: Page, delta: number): Promise<void> {
            await preview.locator('#viewport').hover({ timeout: 5000 });
            await preview.keyboard.down('Control');
            try {
                await preview.mouse.wheel(0, delta);
            } finally {
                await preview.keyboard.up('Control');
            }
        }
        const pdfZoom: Locator = statement.getByRole('combobox', { name: 'Zoom' });
        await pdfZoom.click({ timeout: 5000 });
        await statement.getByRole('option', { name: '100%', exact: true }).click({ timeout: 5000 });
        const pdfPage: Locator = statement.locator('canvas');
        await expect(pdfPage).toHaveAttribute('width', '600');
        await wheelZoom(statement, -100);
        await expect(pdfPage).toHaveAttribute('width', '660');
        await expect(pdfZoom).toContainText('110%');
        expect(await statement.evaluate(async (): Promise<{ stylesAllowed: boolean; offline: boolean; }> => {
            const root: Element | null = document.querySelector('app-preview-controls');
            const styles: HTMLStyleElement[] = [...document.querySelectorAll('style')].filter((style: HTMLStyleElement): boolean => style.textContent?.includes('wig-button-min-height'));
            const offline: boolean = await fetch('https://example.invalid/').then((): boolean => false, (): boolean => true);
            return { stylesAllowed: styles.some((style: HTMLStyleElement): boolean => style.nonce === root?.getAttribute('ngCspNonce') && !!style.sheet), offline };
        })).toEqual({ stylesAllowed: true, offline: true });
        const independent: boolean = await app.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): boolean => BrowserWindow.getAllWindows()
            .filter((window: Electron.BrowserWindow): boolean => window.webContents.getURL() === 'receiptmatch-extraction://preview/index.html')
            .every((window: Electron.BrowserWindow): boolean => !window.isModal() && window.getParentWindow() === null && window.isResizable()));
        expect(independent).toBe(true);

        const sources: Locator = main.getByRole('region', { name: 'Supporting documents' });
        const files: Locator = sources.getByRole('table', { name: `Files in ${path.basename(root)}` });
        await expect(files.getByRole('columnheader', { name: 'Actions' })).toBeVisible();
        const previewButton: Locator = files.locator('.document-actions').getByRole('button', { name: 'Open original receipt.png', exact: true });
        const detailsButton: Locator = files.locator('.document-actions').getByRole('button', { name: 'Show details for receipt.png', exact: true });
        await expect(detailsButton.locator('svg')).toBeVisible();
        await expect(previewButton.locator('svg')).toBeVisible();
        await expect(previewButton).toHaveText('');
        await expect(previewButton).toHaveCSS('width', '44px');
        await expect(previewButton).toHaveCSS('height', '44px');
        const [png]: [Page, void] = await Promise.all([app.waitForEvent('window'), previewButton.press('Enter')]);
        await expect.poll((): string => png.url()).toBe('receiptmatch-extraction://preview/index.html');
        await expect(png.getByRole('img')).toBeVisible();
        await expect.poll((): Promise<number> => png.getByRole('img').evaluate((image: HTMLElement | SVGElement): number => (image as HTMLImageElement).naturalWidth)).toBe(600);
        const zoom: Locator = png.getByRole('combobox', { name: 'Zoom' });
        await zoom.press('Enter');
        await png.getByRole('option', { name: '200%', exact: true }).click();
        await expect(png.getByRole('img')).toHaveAttribute('width', '1200');
        await wheelZoom(png, -100);
        await expect(png.getByRole('img')).toHaveAttribute('width', '1260');
        await expect(zoom).toContainText('210%');
        await png.mouse.wheel(0, -100);
        await expect(png.getByRole('img')).toHaveAttribute('width', '1260');
        await wheelZoom(png, 100);
        await expect(png.getByRole('img')).toHaveAttribute('width', '1200');
        await expect(zoom).toContainText('200%');
        await zoom.click();
        await png.getByRole('option', { name: 'Fit to window', exact: true }).click();
        await expect(png.getByRole('img')).not.toHaveAttribute('width', '1200');
        const fitted: number = Number(await png.getByRole('img').getAttribute('width'));
        await wheelZoom(png, -100);
        await expect.poll(async (): Promise<number> => Number(await png.getByRole('img').getAttribute('width'))).toBeGreaterThan(fitted);
        const columns: () => Promise<number[]> = (): Promise<number[]> => files.getByRole('columnheader').evaluateAll((headers: (HTMLElement | SVGElement)[]): number[] => headers.map((header: HTMLElement | SVGElement): number => header.getBoundingClientRect().width));
        const widthsBeforeError: number[] = await columns();
        await rename(path.join(root, 'receipt.png'), movedPng);
        await previewButton.click();
        const feedback: Locator = files.locator('.document-preview-feedback');
        await expect(feedback.getByRole('alert')).toContainText('no longer at its imported location');
        await expect(feedback).toBeVisible();
        expect(await columns()).toEqual(widthsBeforeError);
        await feedback.getByRole('button', { name: 'Relink original receipt.png' }).click();
        await expect(feedback.getByRole('status')).toContainText('Original relinked');
        await expect(previewButton).toBeFocused();
        await main.getByRole('button', { name: 'Match suggestions', exact: true }).click();
        const matches: Locator = main.getByRole('region', { name: 'Match suggestions', exact: true });
        await expect(matches.getByRole('heading', { name: 'receipt.pdf', exact: true })).toBeVisible();
        const candidate: Page = await openPreview(main, 'receipt.pdf');
        await expect(candidate.locator('canvas')).toBeVisible();
        await matches.getByRole('combobox', { name: 'Supporting document' }).click();
        await main.getByRole('option', { name: 'receipt.jpeg', exact: true }).click();
        const jpeg: Page = await openPreview(main, 'receipt.jpeg');
        await expect.poll((): Promise<number> => jpeg.getByRole('img').evaluate((image: HTMLElement | SVGElement): number => (image as HTMLImageElement).naturalWidth)).toBe(600);
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

        const relinkReceipt: Locator = matches.getByRole('button', { name: 'Relink original receipt.pdf', exact: true });
        await relinkReceipt.click();
        await expect(relinkReceipt).not.toHaveAttribute('aria-busy', 'true');
        await expect(matches.getByRole('alert')).toContainText('no longer at its imported location');
        await relinkReceipt.click();
        await expect(matches.getByRole('alert')).toContainText('The selected file differs from the imported original.');
        await relinkReceipt.click();
        await expect(matches.getByText('Original relinked. You can open it again.', { exact: true })).toBeVisible();
        await expect(matches.getByRole('button', { name: 'Open original receipt.pdf', exact: true })).toBeFocused();
        const relocatedReceipt: Page = await openPreview(main, 'receipt.pdf');
        await expect(relocatedReceipt.locator('canvas')).toBeVisible();
        await expect.poll((): Promise<string> => relocatedReceipt.title()).toContain(path.basename(movedReceipt));

        await statement.close();
        await rename(bank.filePath, movedStatement);
        await main.getByRole('button', { name: 'Sources', exact: true }).click();
        const statements: Locator = main.getByRole('region', { name: 'Bank statements', exact: true });
        const statementName: string = path.basename(bank.filePath);
        await statements.getByRole('button', { name: `Open original ${statementName}`, exact: true }).click();
        await expect(statements.getByRole('alert')).toContainText('no longer at its imported location');
        await statements.getByRole('button', { name: `Relink original ${statementName}`, exact: true }).click();
        await expect(statements.getByText('Original relinked. You can open it again.', { exact: true })).toBeVisible();
        const relocatedStatement: Page = await openPreview(main, statementName);
        await expect(relocatedStatement.getByText('Page 1 of 2', { exact: true })).toBeVisible();
        await expect.poll((): Promise<string> => relocatedStatement.title()).toContain(path.basename(movedStatement));
        await main.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(main.getByText('All changes saved', { exact: true })).toBeVisible();
        await main.getByRole('button', { name: 'New', exact: true }).click();
        await expect.poll((): number => app.windows().length).toBe(1);
        await main.getByRole('button', { name: 'Open', exact: true }).click();
        const reopenedStatement: Page = await openPreview(main, statementName);
        await expect(reopenedStatement.getByText('Page 1 of 2', { exact: true })).toBeVisible();
        await expect.poll((): Promise<string> => reopenedStatement.title()).toContain(path.basename(movedStatement));
        await main.getByRole('button', { name: 'Match suggestions', exact: true }).click();
        await expect(matches.getByText('Document assigned · receipt.jpeg', { exact: true })).toBeVisible();
        const reopenedReceipt: Page = await openPreview(main, 'receipt.pdf');
        await expect(reopenedReceipt.locator('canvas')).toBeVisible();
        await expect.poll((): Promise<string> => reopenedReceipt.title()).toContain(path.basename(movedReceipt));
    } finally {
        await app.close();
    }
});
