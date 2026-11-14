import type { BankImportInput, ImportIssue, TransactionCandidate } from "../../src/shared/bank-import.js";
import type { MatchApproval, MatchApprovalSelection } from "../../src/shared/match-approvals.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { MatchSummary } from "../../src/shared/workspace-matching.js";
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test as base, type ElectronApplication, type Page, type Locator, type TestInfo, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs, type TestType } from '@playwright/test';
import Database from 'better-sqlite3';
import { PDFDocument, StandardFonts, type PDFImage, type PDFPage, type PDFFont } from 'pdf-lib';
import { statement, row } from '../unit/bank-fixtures.js';
import { documentRun, retainedDocument } from '../unit/document-fixtures.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';
import { createWorkspace, newMetadata, SCHEMA_VERSION } from '../../electron/store.js';
import type { extractPdfBytes } from '../../electron/extraction/host.js';
import type { WorkspaceCommand, WorkspaceState } from '../../src/shared/protocol.js';

type SingletonProbe = typeof globalThis & { importSingletonProbe?: ReturnType<typeof extractPdfBytes> };
interface DialogPlan {
	opens?: (string | null)[];
	saves?: (string | null)[];
	choices?: number[];
}
interface ImportReport {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: 'running' | 'passed' | 'failed';
	platform: NodeJS.Platform;
	syntheticOnly: true;
	checks: { name: string; status: 'passed'; milliseconds: number }[];
	limits?: string[];
	error?: string;
	stack?: string;
}
interface BankImportTest {
	root: string;
	report: ImportReport;
	launch: () => Promise<{ application: ElectronApplication; page: Page }>;
	close: () => Promise<void>;
	check: (name: string, action: () => Promise<void>) => Promise<void>;
}
async function mockDialogs(application: ElectronApplication, { opens = [], saves = [], choices = [] }: DialogPlan): Promise<void> {
	await application.evaluate(
		({ dialog }: typeof Electron.CrossProcessExports, plan: { opens: (string | null)[]; saves: (string | null)[]; choices: number[]; }): void => {
			dialog.showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[]; }> => {
				const selected: string | null | undefined = plan.opens.shift();
				return Promise.resolve({ canceled: !selected, filePaths: selected ? [selected] : [] });
			};
			dialog.showSaveDialog = async (): Promise<{ canceled: boolean; filePath: string; }> => {
				const selected: string = plan.saves.shift() ?? '';
				return Promise.resolve({ canceled: !selected, filePath: selected });
			};
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: plan.choices.shift() ?? 2, checkboxChecked: false }));
		},
		{ opens, saves, choices }
	);
}

const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & { bankImport: BankImportTest; }, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = base.extend<{ bankImport: BankImportTest }>({
	bankImport: async ({ playwright }: { bankImport: BankImportTest; } & PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, use: (r: BankImportTest) => Promise<void>, testInfo: TestInfo): Promise<void> => {
		await mkdir('artifacts', { recursive: true });
		const root: string = await mkdtemp(path.resolve('artifacts/import-'));
		const reportPath: string = path.resolve(`artifacts/import-${process.platform}.json`);
		const report: ImportReport = { runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running', platform: process.platform, syntheticOnly: true, checks: [] };
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		let activeApplication: ElectronApplication | undefined;

		async function launch(): Promise<{ application: ElectronApplication; page: Page; }> {
			const application: ElectronApplication = await playwright._electron.launch({
				executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
				args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
				timeout: 30_000
			});
			activeApplication = application;
			application.on('close', (): void => {
				if (activeApplication === application) {
					activeApplication = undefined;
				}
			});
			const page: Page = await application.firstWindow({ timeout: 30_000 });
			page.setDefaultTimeout(30_000);
			await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
			return { application, page };
		}

		async function close(): Promise<void> {
			const application: ElectronApplication | undefined = activeApplication;
			if (application) {
				try {
					await mockDialogs(application, { choices: [1] });
				} finally {
					await application.close();
				}
			}
		}

		async function check(name: string, action: () => Promise<void>): Promise<void> {
			const start: number = performance.now();
			await test.step(name, action);
			report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start) });
		}

		await use({ root, report, launch, close, check });
		let cleanupError: unknown;
		try {
			await close();
		} catch (error: unknown) {
			cleanupError = error;
		}
		report.status = testInfo.status === 'passed' && cleanupError === undefined ? 'passed' : 'failed';
		report.error = testInfo.error?.message ?? (cleanupError === undefined ? undefined : (cleanupError instanceof Error ? cleanupError.message : JSON.stringify(cleanupError)));
		report.stack = testInfo.error?.stack ?? (cleanupError instanceof Error ? cleanupError.stack : undefined);
		report.finishedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		if (cleanupError !== undefined) {
			throw cleanupError instanceof Error ? cleanupError : new Error('Test cleanup failed.', { cause: cleanupError });
		}
	}
});

const sha: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function fingerprint(file: string): Promise<string> {
	return sha(await readFile(file));
}

async function fixture(file: string, partial: boolean = false, title: string = 'Independently invented statement'): Promise<void> {
	const input: BankImportInput = statement();
	if (partial) {
		input.pages[0].spans.push(...row(335, '26 Feb 2032', 'To: Cedar Tools', null, null));
	}
	const pdf: PDFDocument = await PDFDocument.create();
	pdf.setTitle(title);
	const font: PDFFont = await pdf.embedFont(StandardFonts.Helvetica);
	for (const item of input.pages) {
		const sheet: PDFPage = pdf.addPage([item.width, item.height]);
		for (const span of item.spans) {
			sheet.drawText(span.text, { x: span.region.x, y: item.height - span.region.y - 10, size: 10, font });
		}
	}
	await writeFile(file, await pdf.save());
}
test.describe.configure({ timeout: 180_000 });

test('packaged Electron bank import', async ({ bankImport: { root, report, launch, close, check } }: PlaywrightTestArgs & PlaywrightTestOptions & { bankImport: BankImportTest; } & PlaywrightWorkerArgs & PlaywrightWorkerOptions): Promise<void> => {
	let application: ElectronApplication;
	let page: Page;
	async function dialogs(plan: DialogPlan): Promise<void> {
		await mockDialogs(application, plan);
	}

	async function command(value: WorkspaceCommand): Promise<WorkspaceState> {
		return page.evaluate((payload: { type: "get-state"; } | { type: "new"; } | { type: "open"; } | { type: "save"; } | { type: "import-statement"; } | { type: "import-documents"; } | { type: "cancel-import"; } | { type: "rename"; name: string; } | { type: "set-transaction-ignored"; revision: number; transactionId: string; ignored: boolean; remember?: true | undefined; } | { type: "review-match"; revision: number; transactionId: string; review: { status: "open"; } | { status: "assigned"; documentId: string; } | { status: "completed-without-document"; }; } | { type: "set-duplicate-decision"; revision: number; transactionId: string; otherTransactionId: string; decision: "separate" | "keep-first" | "keep-second" | "clear"; } | { type: "correct-bank-row"; revision: number; rowId: string; changes: { bookingDate?: string | undefined; accountAmount?: { coefficient: string; currency: string; scale: number; } | undefined; }; } | { change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; }; documentId: string; sectionId: string; fieldId: string | null; type: "correct-document-field"; revision: number; } | { type: "approve-matches"; loadRevision: number; selections: MatchApprovalSelection[]; }): Promise<WorkspaceState> => window.receiptmatch.command(payload), value);
	}

	async function records(): Promise<StoredBankImport[]> {
		return page.evaluate((): Promise<StoredBankImport[]> => window.receiptmatch.bankImports());
	}

	async function reopen(file: string): Promise<WorkspaceState> {
		await close();
		({ application, page } = await launch());
		await dialogs({ opens: [file] });
		const state: WorkspaceState = await command({ type: 'open' });
		assert.equal(state.error, null);
		assert.equal(state.workspace?.filePath, file);
		return state;
	}

	const original: string = path.join(root, 'invented-statement.pdf');
	await fixture(original);
	const duplicate: string = path.join(root, 'same-bytes-different-name.pdf');
	await copyFile(original, duplicate);
	const partial: string = path.join(root, 'invented-partial.pdf');
	await fixture(partial, true, 'Explicit unresolved payment');
	const independent: string = path.join(root, 'independent-same-amounts.pdf');
	await fixture(independent, false, 'Different source with equal transaction amounts');
	const invalid: string = path.join(root, 'malformed.pdf');
	await writeFile(invalid, 'Not a PDF.');
	const unknown: string = path.join(root, 'unknown-bank.pdf');
	const unknownPdf: PDFDocument = await PDFDocument.create();
	const unknownFont: PDFFont = await unknownPdf.embedFont(StandardFonts.Helvetica);
	unknownPdf.addPage().drawText('Unsupported synthetic bank layout', { font: unknownFont });
	await writeFile(unknown, await unknownPdf.save());
	const file: string = path.join(root, 'records.receiptmatch');
	const originalHash: string = await fingerprint(original);
	({ application, page } = await launch());
	await check('only-active-workspace-frame-can-use-path-free-import-api', async (): Promise<void> => {
		assert.deepEqual(await records(), []);
		assert.equal((await command({ type: 'import-statement' })).workspace, null);
		const unsupportedCommand: { readonly type: "import-statement"; readonly filePath: string; } = { type: 'import-statement', filePath: original } as const;
		const denied: WorkspaceState = await command(unsupportedCommand);
		assert.match(denied.error ?? '', /not supported/);
		const probe: unknown = await application.evaluate(async ({ app, BrowserWindow }: typeof Electron.CrossProcessExports): Promise<unknown> => {
			const extra: Electron.CrossProcessExports.BrowserWindow = new BrowserWindow({
				show: false,
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: `${app.getAppPath()}/.build/preload.cjs` }
			});
			try {
				await extra.loadURL('receiptmatch://app/index.html');
				return await extra.webContents.executeJavaScript(
					"Promise.all([window.receiptmatch.bankImports(), window.receiptmatch.command({type:'import-statement'})].map(value => value.then(() => 'allowed', () => 'denied')))"
				);
			} finally {
				extra.destroy();
			}
		});
		assert.deepEqual(probe, ['denied', 'denied']);
	});
	await command({ type: 'new' });
	await command({ type: 'rename', name: 'Synthetic import records' });
	await dialogs({ saves: [file] });
	await command({ type: 'save' });
	let imported: StoredBankImport;
	await check('native-import-uses-shared-engine-and-remains-unsaved-until-explicit-save', async (): Promise<void> => {
		const before: string = await fingerprint(file);
		await application.evaluate(
			({ app }: typeof Electron.CrossProcessExports, base64: string): void => {
				const require: NodeJS.Require = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`);
				const host: typeof import('../../electron/extraction/host.js') = require(`${app.getAppPath()}/.build/extraction-host.cjs`) as typeof import('../../electron/extraction/host.js');
				app.once('browser-window-created', (): void => {
					(globalThis as SingletonProbe).importSingletonProbe = host.extractPdfBytes(Buffer.from(base64, 'base64'), 'independent-singleton-probe');
				});
			},
			(await readFile(original)).toString('base64')
		);
		await dialogs({ opens: [original] });
		const state: WorkspaceState = await command({ type: 'import-statement' });
		assert.equal(state.error, null);
		assert.equal(state.importOutcome?.status, 'imported');
		assert.equal(state.workspace?.dirty, true);
		assert.equal(await fingerprint(file), before);
		assert.equal(await fingerprint(original), originalHash);
		[imported] = await records();
		storedBankImportSchema.parse(imported);
		assert.equal(imported.result.transactions.length, 2);
		assert.equal(imported.result.unresolvedDrafts.length, 0);
		assert.equal(imported.result.transactions[0].accountAmount?.value.coefficient, '-123456');
		assert.equal(imported.result.transactions[0].reportedOriginalAmount?.value.coefficient, '-150001');
		assert.equal(imported.result.transactions[1].accountAmount?.value.coefficient, '2507');
		assert.equal(imported.result.sourceProvenance?.sha256, originalHash);
		const singleton: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } | undefined = await application.evaluate((): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> | undefined => (globalThis as SingletonProbe).importSingletonProbe);
		assert.equal(singleton?.status, 'failed');
		assert.equal(singleton.issues[0].code, 'busy');
	});
	await check('identical-unsaved-source-is-skipped-without-adding-records', async (): Promise<void> => {
		await dialogs({ opens: [duplicate] });
		const state: WorkspaceState = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'skipped');
		assert.equal(state.workspace?.dirty, true);
		assert.deepEqual(await records(), [imported]);
	});
	await command({ type: 'save' });
	await check('explicit-save-restart-and-duplicate-skip-preserve-full-import-and-clean-state', async (): Promise<void> => {
		await reopen(file);
		assert.deepEqual(await records(), [imported]);
		const before: string = await fingerprint(file);
		await dialogs({ opens: [duplicate] });
		const state: WorkspaceState = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'skipped');
		assert.equal(state.workspace?.dirty, false);
		assert.equal(await fingerprint(file), before);
	});
	let retained: StoredBankImport[];
	await check('partial-import-preserves-unresolved-fields-evidence-and-exact-values-after-restart', async (): Promise<void> => {
		await dialogs({ opens: [partial] });
		const state: WorkspaceState = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'imported');
		assert.equal(state.workspace?.dirty, true);
		retained = await records();
		const record: StoredBankImport | undefined = retained.at(-1);
		assert.ok(record);
		assert.equal(record.result.status, 'partial');
		assert.equal(record.result.transactions.length, 2);
		assert.equal(record.result.unresolvedDrafts.length, 1);
		assert.equal(record.result.unresolvedDrafts[0].accountAmount, null);
		assert.equal(record.drafts.length, 1);
		assert.ok(record.result.unresolvedDrafts[0].evidence.length);
		assert.ok(record.result.unresolvedDrafts[0].issues.length);
		await command({ type: 'save' });
		await reopen(file);
		assert.deepEqual(await records(), retained);
	});
	await check('unsupported-unreadable-password-and-cancelled-selection-preserve-current-work', async (): Promise<void> => {
		const before: string = await fingerprint(file);
		for (const [selected, outcome] of [
			[unknown, 'unsupported'],
			[invalid, 'failed'],
			[path.resolve('tests/fixtures/password-required.pdf'), 'failed'],
			[null, 'cancelled']
		] as const) {
			await dialogs({ opens: [selected] });
			const state: WorkspaceState = await command({ type: 'import-statement' });
			assert.equal(state.importOutcome?.status, outcome);
			assert.equal(state.workspace?.dirty, false);
			assert.deepEqual(await records(), retained);
			assert.equal(await fingerprint(file), before);
		}
	});
	await check('equal-amounts-in-different-sources-are-kept-and-failed-save-retains-unsaved-work', async (): Promise<void> => {
		await dialogs({ opens: [independent] });
		const state: WorkspaceState = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'imported');
		const pending: StoredBankImport[] = await records();
		assert.equal(pending.length, 3);
		assert.notEqual(pending[0].transactions[0].transactionId, pending[2].transactions[0].transactionId);
		const before: string = await fingerprint(file);
		await rename(file, `${file}.away`);
		try {
			const failed: WorkspaceState = await command({ type: 'save' });
			assert.ok(failed.error);
			assert.equal(failed.workspace?.dirty, true);
			assert.deepEqual(await records(), pending);
		} finally {
			await rename(`${file}.away`, file);
		}
		assert.equal(await fingerprint(file), before);
		const saved: WorkspaceState = await command({ type: 'save' });
		assert.equal(saved.workspace?.dirty, false);
		await reopen(file);
		retained = pending;
		assert.deepEqual(await records(), retained);
		const db: Database.Database = new Database(file, { readonly: true });
		try {
			assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM transactions').get()?.n, 6);
			assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bank_imports').get()?.n, 3);
		} finally {
			db.close();
		}
	});
	await check('active-import-cancels-through-renderer-ipc-and-cannot-replace-workspace', async (): Promise<void> => {
		const png: string = await page.evaluate((): string => {
			const canvas: HTMLCanvasElement = document.createElement('canvas');
			canvas.width = 1200;
			canvas.height = 1600;
			const ctx: CanvasRenderingContext2D = canvas.getContext('2d')!;
			ctx.fillStyle = 'white';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = 'black';
			ctx.font = '32px sans-serif';
			for (let line: number = 0; line < 35; line++) {
				ctx.fillText(`Synthetic cancellation page line ${line + 1} TOTAL EUR 123.45`, 35, 60 + line * 42);
			}
			return canvas.toDataURL('image/png').split(',')[1];
		});
		const scan: PDFDocument = await PDFDocument.create();
		const image: PDFImage = await scan.embedPng(Buffer.from(png, 'base64'));
		scan.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
		const selected: string = path.join(root, 'synthetic-cancellation.pdf');
		await writeFile(selected, await scan.save());
		const before: string = await fingerprint(file);
		await dialogs({ opens: [selected] });
		const result: { state: WorkspaceState; guarded: WorkspaceState[] | undefined; cancelled: boolean; } = await page.evaluate(async (): Promise<{ state: WorkspaceState; guarded: WorkspaceState[] | undefined; cancelled: boolean; }> => {
			let guarded: Promise<WorkspaceState[]> | undefined;
			let cancelling: Promise<WorkspaceState> | undefined;
			const unsubscribe: () => void = window.receiptmatch.subscribe((state: WorkspaceState): void => {
				if (state.statementImport?.progress?.phase === 'ocr' && !cancelling) {
					guarded = Promise.all((['new', 'open', 'save'] as const).map((type: "new" | "open" | "save"): Promise<WorkspaceState> => window.receiptmatch.command({ type })));
					cancelling = window.receiptmatch.command({ type: 'cancel-import' });
				}
			});
			try {
				const state: WorkspaceState = await window.receiptmatch.command({ type: 'import-statement' });
				return { state, guarded: await guarded, cancelled: Boolean(cancelling) };
			} finally {
				unsubscribe();
			}
		});
		assert.equal(result.cancelled, true);
		assert.ok(result.guarded?.length === 3 && result.guarded.every((state: WorkspaceState): string | null => state.error));
		assert.equal(result.state.importOutcome?.status, 'cancelled');
		assert.equal(result.state.workspace?.filePath, file);
		assert.equal(result.state.workspace?.dirty, false);
		assert.deepEqual(await records(), retained);
		assert.equal(await fingerprint(file), before);
		await dialogs({ opens: [duplicate] });
		assert.equal((await command({ type: 'import-statement' })).importOutcome?.status, 'skipped');
	});
	await check('legacy-workspace-stays-read-only-until-save-and-preserves-manual-decisions-during-migration', async (): Promise<void> => {
		const legacy: string = path.join(root, 'legacy.receiptmatch');
		await createWorkspace(legacy, { ...newMetadata(), name: 'Legacy decisions' });
		const seed: Database.Database = new Database(legacy);
		seed.pragma('foreign_keys=ON');
		try {
			// The seven original tables are unchanged; remove the additive manifest to reproduce format 1.
			seed.exec(`DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews;
                DROP TABLE match_results; DROP TABLE document_imports; DROP TABLE bank_imports; PRAGMA user_version=1;
                INSERT INTO sources VALUES('legacy-source','/synthetic/original.pdf',NULL);
                INSERT INTO accounts VALUES('legacy-account','Legacy account','EUR');
                INSERT INTO statements VALUES('legacy-statement','legacy-account','legacy-source');
                INSERT INTO transactions VALUES('legacy-transaction','legacy-statement','9007199254740993','EUR',2,1);
                INSERT INTO documents VALUES('legacy-document','legacy-source',1);
                INSERT INTO associations VALUES('legacy-association','legacy-transaction','legacy-document','uncertain',1,'1:1:1');`);
		} finally {
			seed.close();
		}
		const before: string = await fingerprint(legacy);
		const opened: WorkspaceState = await reopen(legacy);
		assert.equal(opened.workspace?.dirty, false);
		assert.equal(await fingerprint(legacy), before);
		await dialogs({ opens: [original] });
		const importedState: WorkspaceState = await command({ type: 'import-statement' });
		assert.equal(importedState.importOutcome?.status, 'imported');
		assert.equal(importedState.workspace?.dirty, true);
		assert.equal(await fingerprint(legacy), before);
		assert.equal((await command({ type: 'save' })).workspace?.dirty, false);
		const db: Database.Database = new Database(legacy, { readonly: true });
		try {
			assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
			assert.equal(
				db.prepare<[string], { coefficient: string }>('SELECT coefficient FROM transactions WHERE id=?').get('legacy-transaction')?.coefficient,
				'9007199254740993'
			);
			assert.deepEqual(db.prepare('SELECT confidence,approved_revision FROM associations WHERE id=?').get('legacy-association'), {
				confidence: 'uncertain',
				approved_revision: '1:1:1'
			});
		} finally {
			db.close();
		}
		await reopen(legacy);
		const savedImports: StoredBankImport[] = await records();
		assert.equal(savedImports.length, 1);
		assert.equal(savedImports[0].result.transactions.length, 2);
	});
	await check('booking-correction-promotes-a-draft-and-restores-original-evidence-after-reopening', async (): Promise<void> => {
		const source: StoredBankImport | undefined = retained.find((record: StoredBankImport): boolean => record.filePath === partial);
		assert.ok(source);
		const file: string = path.join(root, 'booking-correction.receiptmatch');
		await createWorkspace(file, newMetadata(), [source]);
		await reopen(file);
		const before: string = await fingerprint(file);
		const draft: Locator = page.getByTestId('drafts-table').getByRole('row', { name: /Cedar Tools/ });
		await draft.getByRole('button', { name: 'Correct booking details' }).press('Enter');
		const editor: Locator = page.getByRole('dialog', { name: 'Correct booking details' });
		await expect(editor.getByRole('button', { name: 'Close' })).toBeFocused();
		await editor.getByLabel('Booking date', { exact: true }).fill('2032-02-25');
		const decimal: string = await page.evaluate((): string => new Intl.NumberFormat().formatToParts(1.1).find((part: Intl.NumberFormatPart): boolean => part.type === 'decimal')?.value ?? '.');
		await editor.getByLabel('Account amount (EUR)').fill(`-256${decimal}20`);
		await editor.getByRole('button', { name: 'Apply correction' }).click();
		await expect(editor.getByText('Correction applied to this workspace.')).toBeVisible();
		await expect(editor.getByText('Unknown', { exact: true })).toBeVisible();
		assert.equal(await fingerprint(file), before);
		await editor.getByRole('button', { name: 'Close' }).click();
		await expect(editor).toBeHidden();
		await expect(draft).toHaveCount(0);
		const transaction: Locator = page.getByTestId('transactions-table').getByRole('row', { name: /Cedar Tools/ });
		await expect(transaction.getByText('Corrected', { exact: true })).toBeVisible();
		await expect(transaction.getByText(/256[.,]20/)).toBeVisible();
		await expect(transaction.getByRole('button', { name: 'Correct booking details' })).toBeFocused();
		await page.getByRole('button', { name: 'Match suggestions' }).click();
		await expect(page.getByRole('row', { name: /Cedar Tools/ })).toBeVisible();
		await command({ type: 'save' });
		const reopened: WorkspaceState = await reopen(file);
		assert.deepEqual(await records(), [source]);
		assert.equal(reopened.workspace?.imports[0].drafts, 0);
		assert.deepEqual(reopened.workspace?.bankCorrections[0], {
			rowId: source.drafts[0].draftId, revision: 2, bookingDate: '2032-02-25', accountAmount: { currency: 'EUR', coefficient: '-25620', scale: 2 }
		});
		await expect(page.getByTestId('transactions-table').getByRole('row', { name: /Cedar Tools.*Corrected/ })).toBeVisible();
	});
	await check('batch-approval-rejects-a-changed-selection-and-preserves-approved-status-after-reopening', async (): Promise<void> => {
		const source: StoredBankImport | undefined = structuredClone(retained.find((record: StoredBankImport): boolean => record.filePath === original));
		assert.ok(source);
		const [assigned, second]: { rowId: string; transactionId: string; }[] = source.transactions;
		const completed: { rowId: string; transactionId: `${string}-${string}-${string}-${string}-${string}`; } = { rowId: 'completed-without-document', transactionId: randomUUID() };
		const seed: TransactionCandidate = source.result.transactions[0];
		source.result.transactions.push({ ...seed, rowId: completed.rowId, references: [], description: { ...seed.description, value: 'Synthetic no document' } });
		source.transactions.push(completed);
		const document: StoredSupportingDocument = retainedDocument(root, 'approved-receipt.pdf');
		const other: StoredSupportingDocument = retainedDocument(root, 'second-approved-receipt.pdf');
		const file: string = path.join(root, 'approved.receiptmatch');
		const decisions: Map<string, string | null> = new Map([[assigned.transactionId, document.id], [second.transactionId, other.id], [completed.transactionId, null]]);
		await createWorkspace(file, newMetadata(), [source], [documentRun(root, [document, other])], decisions);
		const opened: WorkspaceState = await reopen(file);
		assert.ok(opened.workspace);
		const summaries: (revision: number) => Promise<MatchSummary[] | null> = (revision: number): Promise<MatchSummary[] | null> => page.evaluate((value: number): Promise<MatchSummary[] | null> => window.receiptmatch.matchSummaries(value), revision);
		await page.getByRole('button', { name: 'Match suggestions', exact: true }).click();
		const view: Locator = page.getByRole('region', { name: 'Match suggestions', exact: true });
		const approve: Locator = view.getByRole('button', { name: 'Approve selected' });
		const firstChoice: Locator = view.getByRole('checkbox', { name: /Orchard Workshop/ });
		const secondChoice: Locator = view.getByRole('checkbox', { name: /River Studio/ });
		await expect(approve).toBeDisabled();
		await expect(view.getByRole('checkbox', { name: /Synthetic no document/ })).toHaveCount(0);
		await firstChoice.press('Space');
		await secondChoice.check();
		await expect(view.getByRole('row', { name: /Orchard Workshop/ }).locator('.match-transaction')).toHaveAttribute('aria-current', 'true');
		await expect(view.getByText('2 selected for approval', { exact: true })).toBeVisible();
		await view.getByRole('button', { name: 'Clear selection' }).click();
		await expect(approve).toBeDisabled();
		await expect(view.getByRole('heading', { name: 'Transactions', exact: true })).toBeFocused();
		await firstChoice.check();
		await secondChoice.check();
		await view.getByRole('button', { name: 'Reliable 0' }).click();
		await expect(view.getByText('No transactions with this result.')).toBeVisible();
		await expect(view.getByText(/2 selected for approval.*2 outside this filter/)).toBeVisible();
		await expect(approve).toBeEnabled();
		await view.getByRole('button', { name: 'All 3' }).click();
		await expect(view.getByText('2 selected for approval', { exact: true })).toBeVisible();
		const before: string = await fingerprint(file);
		const changed: WorkspaceState = await command({ type: 'correct-bank-row', revision: opened.workspace.matchRevision, rowId: second.transactionId,
			changes: { bookingDate: '2032-02-24' } });
		assert.equal(changed.error, null);
		await expect(approve).toBeEnabled();
		await approve.click();
		await expect(view.getByRole('alert')).toContainText(/selection for.*River Studio.*changed/);
		await expect(view.getByRole('row', { name: /River Studio/ })).toBeFocused();
		await expect(firstChoice).toBeChecked();
		await expect(secondChoice).not.toBeChecked();
		assert.ok((await summaries(changed.workspace!.matchRevision))?.every((row: MatchSummary): boolean => row.approval === null));
		await secondChoice.check();
		await approve.press('Enter');
		await expect(view.getByText('Selected transactions approved.', { exact: true })).toBeVisible();
		await expect(view.getByText('0 selected for approval', { exact: true })).toBeVisible();
		await expect(firstChoice).toHaveCount(0);
		const approved: WorkspaceState = await command({ type: 'get-state' });
		assert.equal(approved.workspace?.dirty, true);
		assert.equal(await fingerprint(file), before);
		const rows: MatchSummary[] | null = await summaries(approved.workspace.matchRevision);
		const snapshot: MatchApproval | null | undefined = rows?.find((row: MatchSummary): boolean => row.transactionId === assigned.transactionId)?.approval;
		assert.ok(snapshot);
		assert.equal(snapshot.documentId, document.id);
		assert.equal(rows?.find((row: MatchSummary): boolean => row.transactionId === second.transactionId)?.approval?.batchId, snapshot.batchId);
		assert.equal((await command({ type: 'save' })).error, null);
		const reopened: WorkspaceState = await reopen(file);
		const restored: MatchSummary[] | null = await summaries(reopened.workspace!.matchRevision);
		assert.deepEqual(restored?.find((row: MatchSummary): boolean => row.transactionId === assigned.transactionId)?.approval, snapshot);
		assert.equal(restored?.find((row: MatchSummary): boolean => row.transactionId === completed.transactionId)?.approval, null);
		await page.getByRole('button', { name: 'Match suggestions', exact: true }).click();
		const matches: Locator = page.getByRole('region', { name: 'Match suggestions', exact: true });
		const transaction: Locator = matches.getByRole('row', { name: /Orchard Workshop/ });
		await transaction.getByRole('cell').nth(3).click();
		const manual: Locator = matches.getByRole('region', { name: 'Manual review' });
		await expect(manual.getByText('Approved', { exact: true })).toBeVisible();
		const corrected: WorkspaceState = await command({ type: 'correct-bank-row', revision: reopened.workspace!.matchRevision, rowId: assigned.transactionId,
			changes: { bookingDate: '2032-02-25' } });
		assert.equal(corrected.error, null);
		await expect(transaction.getByText('Approval needs review', { exact: true })).toBeVisible();
		await expect(manual.getByText('The booking was corrected.', { exact: false })).toBeVisible();
		await manual.getByRole('button', { name: 'Remove assignment' }).click();
		await expect(manual.getByText('Approval revoked', { exact: true })).toBeVisible();
		await expect(manual.getByText('The document assignment changed.', { exact: false })).toBeVisible();
	});
	assert.equal(await fingerprint(original), originalHash);
	report.limits = [
		'Backend API workflow with synthetic PDF inputs and automation-supplied native dialog choices.',
		'Import controls and transaction views are subsequent work; no installer or sustained-workload certification.'
	];
});
