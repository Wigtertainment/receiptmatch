import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { expect, test, type ElectronApplication, type Locator, type Page, type TestInfo, type PlaywrightWorkerArgs } from '@playwright/test';
import { prepareStatementAnalysis } from '../../electron/import/prepare-statement-analysis.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import type { LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';
import type { OriginalAdoptionResult } from '../../src/shared/original-preview.js';
import type { WorkspaceCommand, WorkspaceState } from '../../src/shared/protocol.js';
import type { StatementAiAcceptRequest, StatementAiDiscardRequest, StatementAiPreviewResult, StatementAiRequest } from '../../src/shared/statement-ai.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { retainedBank } from '../unit/document-fixtures.js';
import { statement } from '../unit/bank-fixtures.js';

type Preview = Extract<StatementAiPreviewResult, { status: 'ready' }>;
type Mode = 'ready' | 'blocked' | 'progress' | 'error' | 'accept-error';
interface UiFixture {
    mode: Mode; state: WorkspaceState; current: StoredBankImport; suggested: StoredBankImport; preview: Preview;
    discarded: string[]; accepted: StatementAiAcceptRequest[]; pending?: (value: StatementAiPreviewResult) => void;
}
interface MainGlobals { statementAiUi?: UiFixture }

async function seed(root: string): Promise<{ file: string; original: StoredBankImport; suggested: StoredBankImport; preview: Preview }> {
    await mkdir(root, { recursive: true });
    const original: StoredBankImport = retainedBank(root);
    const pdf: PDFDocument = await PDFDocument.create();
    const page: PDFPage = pdf.addPage([600, 840]);
    for (const span of statement().pages[0].spans) {
        page.drawText(span.text, { x: span.region.x, y: 840 - span.region.y - span.region.height, size: 9 });
    }
    const bytes: Uint8Array = await pdf.save();
    await writeFile(original.filePath, bytes);
    original.result.sourceProvenance!.sha256 = createHash('sha256').update(bytes).digest('hex');
    const file: string = path.join(root, 'workspace.receiptmatch');
    await createWorkspace(file, newMetadata(), [original]);
    const proposed: StoredBankImport['result'] = structuredClone(original.result);
    proposed.adapter = null;
    proposed.localRecognition = { model: 'nuextract3', parserVersion: '1' };
    proposed.transactions[0].bookingDate.value = '2032-03-05';
    const plan: ReturnType<typeof prepareStatementAnalysis> = prepareStatementAnalysis(original, original, proposed);
    return { file, original, suggested: plan.version.record, preview: { status: 'ready', model: 'nuextract3', result: plan.version.record.result,
        previous: original.result, token: randomUUID(), changes: plan.changes, summary: plan.summary, conflicts: ['Existing approvals will need review after this change.'] } };
}

async function mockAnalysis(application: ElectronApplication, fixture: UiFixture): Promise<void> {
    const status: LocalOcrStatus = { installed: true, cpuAvailable: true, device: 'cpu', effectiveDevice: 'cpu', modelDownloadBytes: 3459015168,
        vulkanDownloadBytes: 38023440, gpu: 'unchecked', download: null, busy: false, failedDownload: null };
    await application.evaluate(({ ipcMain, BrowserWindow }: typeof Electron.CrossProcessExports, input: { fixture: UiFixture; status: LocalOcrStatus }): void => {
        const fixture: UiFixture = input.fixture;
        (globalThis as MainGlobals).statementAiUi = fixture;
        const publish: () => void = (): void => {
            BrowserWindow.getAllWindows()[0].webContents.send('workspace:state', fixture.state);
        };
        for (const channel of ['app:local-ocr', 'workspace:reanalyze-statement', 'workspace:accept-statement-analysis', 'workspace:discard-statement-analysis', 'workspace:bank-imports', 'workspace:command']) {
            ipcMain.removeHandler(channel);
        }
        ipcMain.handle('app:local-ocr', (): LocalOcrStatus => input.status);

        ipcMain.handle('workspace:bank-imports', (): StoredBankImport[] => [fixture.current]);

        ipcMain.handle('workspace:command', (_event: Electron.IpcMainInvokeEvent, command: WorkspaceCommand): WorkspaceState => {
            if (command.type === 'cancel-import' && fixture.pending) {
                fixture.state.busy = false;
                fixture.state.statementImport = null;
                fixture.pending({ status: 'cancelled' });
                delete fixture.pending;
                publish();
            } else if (command.type !== 'get-state') {
                throw new Error('Unexpected command in the isolated AI UI fixture: ' + command.type);
            }
            return fixture.state;
        });

        ipcMain.handle('workspace:reanalyze-statement', (): StatementAiPreviewResult | Promise<StatementAiPreviewResult> => {
            if (fixture.mode === 'error') {
                return { status: 'failed', error: 'Synthetic local recognition failure. Your current statement is unchanged.' };
            }
            if (fixture.mode === 'progress') {
                fixture.state.busy = true;
                fixture.state.statementImport = { cancelling: false, localAi: true, progress: { phase: 'ocr', pageNumber: 1, pageCount: 2, completedPages: 0, device: 'cpu' } };
                publish();
                return new Promise((resolve: (value: StatementAiPreviewResult) => void): void => {
                    fixture.pending = resolve;
                });
            }
            return fixture.mode === 'blocked' ? { ...fixture.preview, blockingConflict: '1 protected bank row would change or disappear. Existing corrections must be preserved.' } : fixture.preview;
        });

        ipcMain.handle('workspace:discard-statement-analysis', (_event: Electron.IpcMainInvokeEvent, request: StatementAiDiscardRequest): void => {
            fixture.discarded.push(request.token);
        });

        ipcMain.handle('workspace:accept-statement-analysis', (_event: Electron.IpcMainInvokeEvent, request: StatementAiAcceptRequest): OriginalAdoptionResult => {
            fixture.accepted.push(request);
            if (fixture.mode === 'accept-error') {
                return { status: 'failed', error: 'Synthetic confirmation failure. Review remains open.' };
            }
            if (request.token !== fixture.preview.token || !request.acknowledgeConflicts || fixture.mode === 'blocked') {
                return { status: 'failed', error: 'The analysis was not acknowledged or is blocked.' };
            }
            fixture.current = fixture.suggested;
            fixture.state.workspace!.matchRevision++;
            fixture.state.workspace!.dirty = true;
            publish();
            return { status: 'adopted' };
        });
    }, { fixture, status });
}

async function setMode(application: ElectronApplication, mode: Mode): Promise<void> {
    await application.evaluate((_electron: typeof Electron.CrossProcessExports, mode: Mode): void => {
        (globalThis as MainGlobals).statementAiUi!.mode = mode;
    }, mode);
}

async function nativeChecks(page: Page, importId: string, loadRevision: number): Promise<void> {
    const malformed: { analysis: StatementAiPreviewResult; accept: OriginalAdoptionResult; discardDenied: boolean } = await page.evaluate(async (request: StatementAiRequest): Promise<{ analysis: StatementAiPreviewResult; accept: OriginalAdoptionResult; discardDenied: boolean }> => {
        const bridge: { reanalyzeStatement(value: unknown): Promise<StatementAiPreviewResult>; acceptStatementAnalysis(value: unknown): Promise<OriginalAdoptionResult>; discardStatementAnalysis(value: unknown): Promise<void> } = window.receiptmatch;
        return { analysis: await bridge.reanalyzeStatement({ ...request, unexpected: true }),
            accept: await bridge.acceptStatementAnalysis({ token: request.importId, loadRevision: request.loadRevision, acknowledgeConflicts: true, unexpected: true }),
            discardDenied: await bridge.discardStatementAnalysis({ token: request.importId, loadRevision: request.loadRevision, unexpected: true }).then((): boolean => false, (): boolean => true) };
    }, { importId, loadRevision });
    expect(malformed.analysis).toMatchObject({ status: 'failed', error: 'Invalid statement analysis request.' });
    expect(malformed.accept).toMatchObject({ status: 'failed', error: 'Invalid statement analysis confirmation.' });
    expect(malformed.discardDenied).toBe(true);
    const unavailable: StatementAiPreviewResult = await page.evaluate((request: StatementAiRequest): Promise<StatementAiPreviewResult> => window.receiptmatch.reanalyzeStatement(request), { importId, loadRevision });
    expect(unavailable.status).toBe('unavailable');
}

async function review(page: Page, analyze: Locator): Promise<Locator> {
    await analyze.click();
    const dialog: Locator = page.getByRole('dialog', { name: 'Review AI statement analysis', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Review AI statement analysis', exact: true })).toBeFocused();
    return dialog;
}

async function screenshot(application: ElectronApplication, file: string): Promise<void> {
    const png: string = await application.evaluate(async ({ BrowserWindow }: typeof Electron.CrossProcessExports): Promise<string> => {
        const window: Electron.BrowserWindow = BrowserWindow.getAllWindows()[0];
        window.webContents.invalidate();
        const image: Electron.NativeImage = await window.webContents.capturePage(undefined, { stayAwake: true, stayHidden: true });
        if (image.isEmpty()) {
            throw new Error('The native viewport capture is empty.');
        }
        return image.toPNG().toString('base64');
    });
    await writeFile(file, Buffer.from(png, 'base64'));
}

test('reviews local AI statement changes safely, keeps drafts on discard and supports cancellation and narrow layouts', async ({ playwright }: PlaywrightWorkerArgs, testInfo: TestInfo): Promise<void> => {
    test.setTimeout(120_000);
    const root: string = testInfo.outputPath('data');
    const prepared: Awaited<ReturnType<typeof seed>> = await seed(root);
    const bytes: NonSharedBuffer = await readFile(prepared.file);
    const executablePath: unknown = (await import('electron')).default;
    assert.equal(typeof executablePath, 'string');
    const application: ElectronApplication = await playwright._electron.launch({ executablePath: executablePath as string,
        args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')], env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true });
    try {
        await application.evaluate(({ BrowserWindow, dialog }: typeof Electron.CrossProcessExports, file: string): void => {
            BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
            BrowserWindow.getAllWindows()[0].setContentSize(1120, 900);
            dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[] }> => Promise.resolve({ canceled: false, filePaths: [file] });
            dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false }> => Promise.resolve({ response: 1, checkboxChecked: false });
        }, prepared.file);
        const page: Page = await application.firstWindow();
        await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
        await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Sources', exact: true }).click();
        const panel: Locator = page.getByRole('region', { name: 'Bank statements', exact: true });
        const analyze: Locator = panel.getByRole('button', { name: 'Analyze with local AI', exact: true });
        await expect(analyze).toBeVisible();
        const state: WorkspaceState = await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'get-state' }));
        await nativeChecks(page, prepared.original.id, state.workspace!.loadRevision);
        await analyze.click();
        await expect(panel.getByRole('alert')).toContainText('Download NuExtract3');
        await expect(panel.getByRole('button', { name: 'Open recognition settings', exact: true })).toBeVisible();
        await mockAnalysis(application, { mode: 'ready', state, current: prepared.original, suggested: prepared.suggested, preview: prepared.preview, discarded: [], accepted: [] });
        let dialog: Locator = await review(page, analyze);
        await expect(dialog.getByRole('button', { name: 'Apply analysis', exact: true })).toBeDisabled();
        await expect(dialog.getByRole('article')).toHaveCount(1);
        await dialog.getByRole('checkbox', { name: 'Show unchanged rows (1)', exact: true }).check();
        await expect(dialog.getByRole('article')).toHaveCount(2);
        await dialog.getByRole('checkbox', { name: 'Show unchanged rows (1)', exact: true }).uncheck();
        await screenshot(application, testInfo.outputPath('statement-analysis-desktop.png'));
        await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].setContentSize(680, 860));
        await expect.poll(async (): Promise<boolean> => dialog.evaluate((element: HTMLElement): boolean => element.scrollWidth <= element.clientWidth)).toBe(true);
        await screenshot(application, testInfo.outputPath('statement-analysis-narrow.png'));
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(analyze).toBeFocused();
        await expect(panel).toContainText('AI analysis discarded. Your current statement is unchanged.');
        expect(await page.evaluate((): Promise<StoredBankImport[]> => window.receiptmatch.bankImports())).toEqual([prepared.original]);
        await setMode(application, 'blocked');
        dialog = await review(page, analyze);
        await expect(dialog).toContainText('1 protected bank row would change or disappear.');
        await expect(dialog.getByRole('button', { name: 'Apply analysis', exact: true })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Discard analysis', exact: true }).click();
        await expect(analyze).toBeFocused();
        await setMode(application, 'ready');
        dialog = await review(page, analyze);
        await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => {
            const fixture: UiFixture = (globalThis as MainGlobals).statementAiUi!;
            fixture.state.workspace!.matchRevision++;
            BrowserWindow.getAllWindows()[0].webContents.send('workspace:state', fixture.state);
        });
        await expect(dialog).not.toBeVisible();
        await expect(panel.getByRole('alert')).toContainText('The workspace changed. Analyze this statement again.');
        await expect(analyze).toBeFocused();
        await setMode(application, 'progress');
        await analyze.click();
        await expect(panel.getByTestId('import-progress')).toContainText('0 of 2 pages completed');
        await panel.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
        await expect(panel).toContainText('AI analysis cancelled. Your current statement is unchanged.');
        await expect(analyze).toBeFocused();
        await setMode(application, 'error');
        await analyze.click();
        await expect(panel.getByRole('alert')).toContainText('Synthetic local recognition failure.');
        await expect(analyze).toBeFocused();
        await setMode(application, 'accept-error');
        dialog = await review(page, analyze);
        await dialog.getByRole('checkbox', { name: /I reviewed these changes/ }).check();
        await dialog.getByRole('button', { name: 'Apply analysis', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('Synthetic confirmation failure.');
        await expect(dialog).toBeVisible();
        await setMode(application, 'ready');
        await dialog.getByRole('button', { name: 'Apply analysis', exact: true }).click();
        await expect(dialog).not.toBeVisible();
        await expect(panel.getByText('Local AI · NuExtract3', { exact: true })).toBeVisible();
        expect(await page.evaluate((): Promise<StoredBankImport[]> => window.receiptmatch.bankImports())).toEqual([prepared.suggested]);
        await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
        const trace: { discarded: number; accepted: StatementAiAcceptRequest[] } = await application.evaluate((): { discarded: number; accepted: StatementAiAcceptRequest[] } => {
            const fixture: UiFixture = (globalThis as MainGlobals).statementAiUi!;
            return { discarded: fixture.discarded.length, accepted: fixture.accepted };
        });
        expect(trace.discarded).toBeGreaterThanOrEqual(3);
        expect(trace.accepted).toHaveLength(2);
        expect(trace.accepted.every((request: StatementAiAcceptRequest): boolean => request.acknowledgeConflicts)).toBe(true);
        expect(await readFile(prepared.file)).toEqual(bytes);
    } finally {
        await application.close();
        assert.equal(path.dirname(path.resolve(root)), path.resolve(testInfo.outputPath()));
        await rm(root, { recursive: true, force: true });
    }
});
