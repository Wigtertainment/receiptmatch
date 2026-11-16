import assert from 'node:assert/strict';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, type PDFImage, type PDFPage } from 'pdf-lib';
import {
    expect, test, type ElectronApplication, type ElementHandle, type Locator, type Page, type PlaywrightTestArgs, type PlaywrightTestOptions,
    type PlaywrightWorkerArgs, type PlaywrightWorkerOptions
} from '@playwright/test';
import { LOCAL_OCR_ASSETS, type ModelAsset } from '../../electron/local-ocr-assets.js';
import type { LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';
import { LOCAL_OCR_VERSIONS, PDF_EXTRACTION_VERSION } from '../../src/shared/pdf-extraction.js';
import type { WorkspaceState } from '../../src/shared/protocol.js';
import type { ReceiptAiPreviewResult } from '../../src/shared/receipt-ai.js';
import type { DocumentFileResult, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';

const modelAssets: readonly ModelAsset[] = LOCAL_OCR_ASSETS['paddleocr-vl-1.6'];
const modelDirectory: string = 'paddleocr-vl-1.6-' + createHash('sha256').update(modelAssets.map((file: ModelAsset): string => file.sha256).join('')).digest('hex');
const receiptName: string = 'cedar.pdf';

async function writeReceipt(page: Page, filePath: string): Promise<string> {
    const image: string = await page.evaluate((): string => {
        const canvas: HTMLCanvasElement = document.createElement('canvas');
        canvas.width = 680;
        canvas.height = 510;
        const context: CanvasRenderingContext2D = canvas.getContext('2d')!;
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = 'black';
        const rows: [string, string][] = [
            ['INVOICE', 'bold 50px Arial'], ['Cedar Workshop', 'bold 36px Arial'], ['Invoice no: RM-0210', '32px Arial'],
            ['Invoice date: 2026-10-12', '32px Arial'], ['Grand total EUR 48.75', 'bold 38px Arial']
        ];
        rows.forEach(([text, font]: [string, string], index: number): void => {
            context.font = font;
            context.fillText(text, 68, 90 + index * 78);
        });
        return canvas.toDataURL('image/png').split(',')[1];
    });
    const pdf: PDFDocument = await PDFDocument.create();
    const receipt: PDFPage = pdf.addPage([340, 255]);
    const scan: PDFImage = await pdf.embedPng(Buffer.from(image, 'base64'));
    receipt.drawImage(scan, { x: 0, y: 0, width: 340, height: 255 });
    const bytes: Uint8Array = await pdf.save();
    await writeFile(filePath, bytes);
    return createHash('sha256').update(bytes).digest('hex');
}

async function stageModel(assets: string, runtime: string, profile: string): Promise<void> {
    const localModel: string = path.join(profile, 'local-ocr', modelDirectory);
    const localRuntime: string = path.join(profile, 'local-ocr-runtimes', 'llama');
    await mkdir(localModel, { recursive: true });
    await mkdir(path.dirname(localRuntime), { recursive: true });
    await cp(runtime, localRuntime, { recursive: true });
    for (const asset of modelAssets) {
        const source: string = path.join(assets, asset.file);
        const hash: Hash = createHash('sha256');
        for await (const chunk of createReadStream(source)) {
            hash.update(chunk as Buffer);
        }
        assert.equal(hash.digest('hex'), asset.sha256, `Installed test file ${asset.file} must match the pinned model.`);
        await copyFile(source, path.join(localModel, asset.file));
    }
}

async function launch(playwright: PlaywrightWorkerArgs['playwright'], profile: string): Promise<{ application: ElectronApplication; page: Page }> {
    const executablePath: unknown = (await import('electron')).default;
    assert.ok(typeof executablePath === 'string');
    const appRoot: string = process.env.RECEIPTMATCH_RECEIPT_AI_APP_ROOT ?? path.resolve('.');
    const application: ElectronApplication = await playwright._electron.launch({
        executablePath, args: [appRoot, '--hidden', '--disable-gpu', `--user-data-dir=${profile}`],
        env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true, timeout: 30_000
    });
    try {
        const page: Page = await application.firstWindow({ timeout: 30_000 });
        await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
        await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
        return { application, page };
    } catch (error: unknown) {
        await application.close();
        throw error;
    }
}

async function dialogs(application: ElectronApplication, open: string, save?: string): Promise<void> {
    await application.evaluate(({ dialog }: typeof Electron.CrossProcessExports, plan: { open: string; save?: string }): void => {
        dialog.showOpenDialog = (): Promise<{ canceled: boolean; filePaths: string[] }> => Promise.resolve({ canceled: false, filePaths: [plan.open] });
        dialog.showSaveDialog = (): Promise<{ canceled: boolean; filePath: string }> => Promise.resolve({ canceled: !plan.save, filePath: plan.save ?? '' });
        dialog.showMessageBox = (): Promise<{ response: number; checkboxChecked: boolean }> => Promise.resolve({ response: 1, checkboxChecked: false });
    }, { open, save });
}

function state(page: Page): Promise<WorkspaceState> {
    return page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'get-state' }));
}

async function importedReceipt(page: Page): Promise<StoredSupportingDocument> {
    const reports: StoredDocumentImport[] = await page.evaluate((): Promise<StoredDocumentImport[]> => window.receiptmatch.documentImports());
    assert.equal(reports.length, 1);
    assert.equal(reports[0].files.length, 1);
    const file: DocumentFileResult = reports[0].files[0];
    assert.equal(file.status, 'imported');
    return file.record;
}

async function choosePreference(page: Page, active: boolean): Promise<void> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: active ? 'Prefer PaddleOCR-VL 1.6' : 'Clear AI preference', exact: true }).click();
    const selected: 'paddleocr-vl-1.6' | 'standard' = active ? 'paddleocr-vl-1.6' : 'standard';
    await expect.poll(async (): Promise<LocalOcrStatus['selection']> =>
        (await page.evaluate((): Promise<LocalOcrStatus> => window.receiptmatch.localOcr({ type: 'status' }))).selection).toBe(selected);
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
}

async function compactActions(row: Locator): Promise<void> {
    const actions: Locator = row.locator('.document-actions');
    await expect(actions.getByRole('button')).toHaveCount(3);
    type ButtonBounds = Pick<DOMRect, 'top' | 'left' | 'right' | 'width' | 'height'> & { label: string | null };
    const bounds: ButtonBounds[] = await actions.evaluate((container: HTMLElement): ButtonBounds[] =>
        Array.from(container.querySelectorAll('button'), (button: HTMLButtonElement): ButtonBounds => {
            const { top, left, right, width, height }: DOMRect = button.getBoundingClientRect();
            return { top, left, right, width, height, label: button.getAttribute('aria-label') };
        }));
    const compact: boolean = bounds.every((button: ButtonBounds): boolean => button.width >= 40 && button.width <= 48 && button.height >= 40 && button.height <= 48);
    const aligned: boolean = bounds.slice(1).every((button: ButtonBounds, index: number): boolean => Math.abs(button.top - bounds[0].top) < 1 && button.left >= bounds[index].right);
    assert.ok(compact && aligned, `Expected three compact, top-aligned actions with no wrapping: ${JSON.stringify(bounds)}`);
}

async function reviewProposal(page: Page, reanalyze: Locator): Promise<Locator> {
    await reanalyze.click();
    const review: Locator = page.getByRole('dialog', { name: 'Review AI receipt analysis', exact: true });
    await expect(review).toBeVisible({ timeout: 125_000 });
    await expect(review.getByRole('heading', { name: /^(Changed|Added|Removed|Sections to compare)\b/ }).first()
        .or(review.getByText('No changes to extracted details were found.', { exact: true }))).toBeVisible();
    const evidence: Locator = review.locator('details').filter({ has: page.getByText('AI analysis evidence', { exact: true }) });
    await evidence.locator('summary').click();
    await expect(evidence).toHaveJSProperty('open', true);
    await expect(evidence).toContainText(/48[.,]75/);
    return review;
}

interface ReviewLayout {
    readonly fitsHorizontally: boolean;
    readonly actionsInView: boolean;
    readonly footerStayedInPlace: boolean;
    readonly bodyScrolled: boolean;
    readonly sectionColumns: number;
}

async function reviewLayout(application: ElectronApplication, page: Page, review: Locator): Promise<void> {
    const scrollArea: Locator = review.getByRole('region', { name: 'Analysis comparison', exact: true });
    await expect(scrollArea).toHaveAttribute('tabindex', '0');
    await review.getByText('Source text', { exact: true }).click();
    await expect(review.locator('.document-source-text')).toHaveJSProperty('open', true);
    await expect(review.locator('.document-source-text app-document-source-page')).toBeVisible();
    for (const [width, height] of [[1120, 740], [520, 420], [1120, 740]]) {
        await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports, size: { width: number; height: number }): void => {
            const window: Electron.BrowserWindow = BrowserWindow.getAllWindows()[0];
            window.setMinimumSize(360, 360);
            window.setContentSize(size.width, size.height);
        }, { width, height });
        await expect.poll(async (): Promise<number> => page.evaluate((): number => innerWidth)).toBe(width);
        const layout: ReviewLayout = await review.evaluate((dialog: HTMLElement): ReviewLayout => {
            const content: HTMLElement | null = dialog.querySelector<HTMLElement>('.receipt-ai-content');
            const footer: HTMLElement | null = dialog.querySelector<HTMLElement>('.receipt-ai-footer');
            const sections: HTMLElement | null = dialog.querySelector<HTMLElement>('.receipt-ai-section-pair');
            if (!content || !footer || !sections) {
                throw new Error('Receipt review must have a scrolling content area, section comparison and footer.');
            }
            const inViewport: (region: DOMRect) => boolean = (region: DOMRect): boolean =>
                region.width > 0 && region.height > 0 && region.left >= -1 && region.top >= -1 && region.right <= innerWidth + 1 && region.bottom <= innerHeight + 1;
            const fitsHorizontally: boolean = [dialog, content, footer].every((element: HTMLElement): boolean => element.scrollWidth <= element.clientWidth + 1);
            content.scrollTop = 0;
            const originalFooter: DOMRect = footer.getBoundingClientRect();
            content.scrollTop = content.scrollHeight;
            const finalFooter: DOMRect = footer.getBoundingClientRect();
            const buttons: HTMLButtonElement[] = Array.from(footer.querySelectorAll('button'));
            const actionsInView: boolean = inViewport(originalFooter) && inViewport(finalFooter) && buttons.length === 2 &&
                buttons.every((button: HTMLButtonElement): boolean => inViewport(button.getBoundingClientRect()));
            const bodyScrolled: boolean = content.scrollTop > 0;
            content.scrollTop = 0;
            const sectionColumns: number = getComputedStyle(sections).gridTemplateColumns.split(' ').length;
            return { fitsHorizontally, actionsInView, footerStayedInPlace: Math.abs(finalFooter.top - originalFooter.top) < 1, bodyScrolled, sectionColumns };
        });
        assert.ok(layout.fitsHorizontally && layout.actionsInView && layout.footerStayedInPlace, `Review layout at ${width} × ${height}: ${JSON.stringify(layout)}`);
        assert.equal(layout.sectionColumns, width === 520 ? 1 : 2);
        if (width === 520) {
            assert.ok(layout.bodyScrolled, 'Expanded evidence must scroll independently of the footer in the narrow window.');
            await scrollArea.focus();
            await expect(scrollArea).toBeFocused();
            await scrollArea.press('PageDown');
            await expect.poll(async (): Promise<number> => scrollArea.evaluate((area: HTMLElement): number => area.scrollTop)).toBeGreaterThan(0);
        }
    }
}

async function mockUnpairedReview(application: ElectronApplication, receipt: StoredSupportingDocument): Promise<void> {
    const currentSection: string = 'Section 2 · Invoice';
    const proposalSection: string = 'Section 3 · Credit note';
    const longReference: string = 'TESTREFERENCE'.repeat(20);
    const result: Extract<ReceiptAiPreviewResult, { status: 'ready' }> = {
        status: 'ready', model: 'paddleocr-vl-1.6', token: randomUUID(), analysis: receipt.result,
        conflicts: ['Review the changed receipt details before applying.'],
        changes: [
            { label: 'Billed total', before: 'EUR 41.80', after: 'EUR 48.75' },
            { label: 'Due date', before: null, after: '2026-11-22' },
            { label: 'Order reference', before: 'TEST-ORDER', after: null },
            { label: 'Optional tax', before: 'No value recognized', after: null, unrecognized: true },
            { label: 'Removed document section', before: currentSection, after: null, kind: 'section' },
            { label: 'Invoice reference', before: `CURRENT-${longReference}`, after: null, section: currentSection },
            { label: 'Added document section', before: null, after: proposalSection, kind: 'section' },
            { label: 'Related invoice reference', before: null, after: `PROPOSED-${longReference}`, section: proposalSection }
        ]
    };
    await application.evaluate(({ ipcMain }: typeof Electron.CrossProcessExports, preview: typeof result): void => {
        ipcMain.removeHandler('workspace:reanalyze-receipt');
        ipcMain.handle('workspace:reanalyze-receipt', (): typeof preview => preview);
    }, result);
}

test('reviews local receipt AI before applying and saves the analysis under the original identity', async (
    { playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions
): Promise<void> => {
    test.skip(process.platform !== 'win32' || process.env.RECEIPTMATCH_RECEIPT_AI_UI !== '1', 'Opt in with Windows and a locally installed PaddleOCR-VL model.');
    const assets: string = process.env.RECEIPTMATCH_RECEIPT_AI_ASSETS ?? path.join(process.env.APPDATA ?? '', 'ReceiptMatch', 'local-ocr', modelDirectory);
    const runtime: string = process.env.RECEIPTMATCH_RECEIPT_AI_RUNTIME ??
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ReceiptMatch', 'resources', 'local-ocr-runtimes', 'llama');
    assert.ok(path.isAbsolute(assets) && path.isAbsolute(runtime));
    test.setTimeout(220_000);
    await mkdir(path.resolve('tmp'), { recursive: true });
    const temporary: string = await realpath(path.resolve('tmp'));
    const root: string = await mkdtemp(path.join(temporary, 'receipt-ai-ui-'));
    const profile: string = path.join(root, 'profile');
    const folder: string = path.join(root, 'receipts');
    const filePath: string = path.join(folder, receiptName);
    const workspace: string = path.join(root, 'receipts.receiptmatch');
    let running: Awaited<ReturnType<typeof launch>> | undefined;
    try {
        await mkdir(folder);
        await stageModel(assets, runtime, profile);
        running = await launch(playwright, profile);
        const { application, page }: Awaited<ReturnType<typeof launch>> = running;
        const sha256: string = await writeReceipt(page, filePath);
        await dialogs(application, folder, workspace);
        await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
        const row: Locator = page.getByRole('row').filter({ hasText: receiptName });
        const reanalyze: Locator = row.getByRole('button', { name: `Reanalyze with AI for ${receiptName}`, exact: true });
        const status: Locator = row.getByRole('cell').nth(2);
        const progress: Locator = status.getByText(/^(Analyzing receipt with AI|Cancelling AI analysis)/);

        const original: StoredSupportingDocument = await test.step('imports using standard extraction despite the AI preference', async (): Promise<StoredSupportingDocument> => {
            await choosePreference(page, true);
            await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
            await expect(page.getByText('Analysis finished.', { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(reanalyze).toBeVisible();
            await expect(row.getByRole('button', { name: `Show details for ${receiptName}`, exact: true })).toBeVisible();
            await expect(row.getByRole('button', { name: `Open original ${receiptName}`, exact: true })).toBeVisible();
            await expect(reanalyze.locator('svg')).toBeVisible();
            await expect(progress).toHaveCount(0);
            await compactActions(row);
            await reanalyze.hover();
            await expect(page.getByRole('tooltip', { name: 'Reanalyze with AI', exact: true })).toBeVisible();
            const imported: StoredSupportingDocument = await importedReceipt(page);
            assert.equal(imported.result.input?.extraction.version, PDF_EXTRACTION_VERSION);
            assert.equal(imported.result.input?.source.sha256, sha256);
            assert.ok(imported.result.input?.pages[0].spans.every((span: NonNullable<StoredSupportingDocument['result']['input']>['pages'][number]['spans'][number]): boolean =>
                span.method === 'local-ocr'));
            return imported;
        });
        const atImport: WorkspaceState = await state(page);
        const revision: number | undefined = atImport.workspace?.matchRevision;
        assert.ok(revision);

        await test.step('shows model settings guidance and cancels live AI recognition without changes', async (): Promise<void> => {
            await choosePreference(page, false);
            await reanalyze.click();
            await expect(page.getByText(/Choose an installed model under Settings.*Document recognition/)).toBeVisible();
            await expect(progress).toHaveCount(0);
            assert.deepEqual(await importedReceipt(page), original);
            await choosePreference(page, true);
            const trigger: ElementHandle<HTMLElement | SVGElement> = await reanalyze.elementHandle();
            await reanalyze.click();
            await expect(progress).toBeVisible();
            await expect.poll(async (): Promise<string | undefined> => (await state(page)).documentImport?.progress?.extraction?.phase, { timeout: 15_000 }).toBe('ocr');
            const cancel: Locator = row.getByRole('button', { name: `Cancel AI analysis for ${receiptName}`, exact: true });
            await expect(cancel).toBeEnabled();
            assert.ok(await cancel.evaluate((button: HTMLElement, original: HTMLElement | SVGElement): boolean => button === original, trigger));
            await expect(page.getByRole('button', { name: 'Cancel AI analysis', exact: true })).toHaveCount(0);
            await compactActions(row);
            await cancel.click();
            await expect(reanalyze).toBeEnabled();
            await expect(progress).toHaveCount(0);
            await expect(page.getByRole('dialog', { name: 'Review AI receipt analysis' })).toHaveCount(0);
            assert.equal((await state(page)).workspace?.matchRevision, revision);
            assert.deepEqual(await importedReceipt(page), original);
        });

        await test.step('shows proposed changes and evidence before discard, without altering the retained analysis', async (): Promise<void> => {
            const review: Locator = await reviewProposal(page, reanalyze);
            await expect(progress).toHaveCount(0);
            assert.deepEqual(await importedReceipt(page), original);
            assert.equal((await state(page)).workspace?.matchRevision, revision);
            await review.getByRole('button', { name: 'Discard AI analysis', exact: true }).click();
            await expect(review).toHaveCount(0);
            await expect(reanalyze).toBeEnabled();
            assert.deepEqual(await importedReceipt(page), original);
            assert.equal((await state(page)).workspace?.matchRevision, revision);
        });

        const updated: StoredSupportingDocument = await test.step('applies to the same receipt and explicitly saves', async (): Promise<StoredSupportingDocument> => {
            const review: Locator = await reviewProposal(page, reanalyze);
            const acknowledgement: Locator = review.getByRole('checkbox', { name: 'I acknowledge the effects listed above.', exact: true });
            if (await acknowledgement.isVisible()) {
                await acknowledgement.check();
            }
            await review.getByRole('button', { name: 'Apply AI analysis', exact: true }).click();
            await expect(review).toHaveCount(0);
            await expect.poll(async (): Promise<string | undefined> => (await importedReceipt(page)).result.input?.extraction.version).toBe(LOCAL_OCR_VERSIONS['paddleocr-vl-1.6']);
            const applied: StoredSupportingDocument = await importedReceipt(page);
            assert.equal(applied.id, original.id);
            assert.equal(applied.filePath, original.filePath);
            assert.deepEqual(applied.result.input?.source, original.result.input?.source);
            assert.notEqual(applied.result.input?.extraction.runId, original.result.input?.extraction.runId);
            assert.equal((await state(page)).workspace?.matchRevision, revision + 1);
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
            return applied;
        });

        await application.close();
        running = undefined;
        running = await launch(playwright, profile);
        const reopened: Awaited<ReturnType<typeof launch>> = running;
        await test.step('reopens the same applied receipt version after restarting Electron', async (): Promise<void> => {
            await dialogs(reopened.application, workspace);
            await reopened.page.getByRole('button', { name: 'Open workspace', exact: true }).click();
            await expect.poll(async (): Promise<string | null | undefined> => (await state(reopened.page)).workspace?.filePath).toBe(workspace);
            assert.deepEqual(await importedReceipt(reopened.page), updated);
        });

    } finally {
        await running?.application.close();
        assert.ok(path.dirname(await realpath(root)) === temporary && path.basename(root).startsWith('receipt-ai-ui-'));
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
});

test('lays out grouped and unpaired receipt comparisons at desktop and narrow sizes', async (
    { playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions
): Promise<void> => {
    test.skip(process.platform !== 'win32' || process.env.RECEIPTMATCH_RECEIPT_AI_UI !== '1', 'Opt in with a Windows desktop build.');
    test.setTimeout(75_000);
    await mkdir(path.resolve('tmp'), { recursive: true });
    const temporary: string = await realpath(path.resolve('tmp'));
    const root: string = await mkdtemp(path.join(temporary, 'receipt-ai-ui-layout-'));
    const folder: string = path.join(root, 'receipts');
    let running: Awaited<ReturnType<typeof launch>> | undefined;
    try {
        await mkdir(folder);
        running = await launch(playwright, path.join(root, 'profile'));
        const { application, page }: Awaited<ReturnType<typeof launch>> = running;
        await writeReceipt(page, path.join(folder, receiptName));
        await dialogs(application, folder);
        await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
        await page.getByRole('button', { name: 'Sources', exact: true }).click();
        await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
        await expect(page.getByText('Analysis finished.', { exact: true })).toBeVisible();
        const receipt: StoredSupportingDocument = await importedReceipt(page);
        await mockUnpairedReview(application, receipt);
        const row: Locator = page.getByRole('row').filter({ hasText: receiptName });
        await compactActions(row);
        const action: Locator = row.getByRole('button', { name: `Reanalyze with AI for ${receiptName}`, exact: true });
        const review: Locator = await reviewProposal(page, action);
        await expect(review.getByRole('region', { name: 'Changed', exact: true })).toContainText('EUR 41.80');
        await expect(review.getByRole('region', { name: 'Added', exact: true })).toContainText('2026-11-22');
        await expect(review.getByRole('region', { name: 'Removed', exact: true })).toContainText('TEST-ORDER');
        await expect(review.getByText('Optional tax', { exact: true })).toHaveCount(0);
        const comparison: Locator = review.getByRole('region', { name: 'Sections to compare', exact: true });
        await expect(comparison).toContainText('Current analysis');
        await expect(comparison).toContainText('AI proposal');
        await expect(comparison).toContainText('CURRENT-TESTREFERENCE');
        await expect(comparison).toContainText('PROPOSED-TESTREFERENCE');
        const apply: Locator = review.getByRole('button', { name: 'Apply AI analysis', exact: true });
        await expect(apply).toBeDisabled();
        await reviewLayout(application, page, review);
        await review.getByRole('checkbox', { name: 'I acknowledge the effects listed above.', exact: true }).check();
        await expect(apply).toBeEnabled();
        await review.getByRole('button', { name: 'Discard AI analysis', exact: true }).click();
        await expect(review).toHaveCount(0);
        assert.deepEqual(await importedReceipt(page), receipt);
    } finally {
        await running?.application.close();
        assert.ok(path.dirname(await realpath(root)) === temporary && path.basename(root).startsWith('receipt-ai-ui-layout-'));
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
});
