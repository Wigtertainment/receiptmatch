import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { BankImportInput, PositionedSpan } from "../../src/shared/bank-import.js";
import type { TransactionMatch } from "../../src/shared/workspace-matching.js";
import type { MatchApprovalSelection } from "../../src/shared/match-approvals.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import type { MatchSummary } from "../../src/shared/workspace-matching.js";
import type { DocumentExportOutcome } from "../../src/shared/document-export.js";
import type { ReconciliationExportReport } from "../../src/shared/document-export.js";
import type { WorkspaceView } from "../../src/shared/protocol.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi, type Mock, type TestContext } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { reconciliationRows } from '../../electron/reconciliation-csv.js';
import { writeReconciliationExport } from '../../electron/reconciliation-export.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { defaultExportFilenamePattern } from '../../src/shared/export-filename.js';
import { advanceReviewRevision, approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { duplicatePairKey } from '../../src/shared/transaction-duplicates.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';
import { statement } from './bank-fixtures.js';
import type { PathLike } from 'node:fs';

async function fixture(context: TestContext, approve: boolean = true): Promise<{ destination: string; file: string; snapshot: SavedWorkspace; first: string; second: string; document: StoredSupportingDocument; }> {
	const root: string = await fs.mkdtemp(path.join(tmpdir(), 'receiptmatch-reconciliation-export-'));
	context.onTestFinished((): Promise<void> => fs.rm(root, { recursive: true, force: true }));
	const originals: string = path.join(root, 'originals');
	const destination: string = path.join(root, 'export');
	await Promise.all([fs.mkdir(originals), fs.mkdir(destination)]);
	const file: string = path.join(root, 'workspace.receiptmatch');
	const bank: StoredBankImport = retainedBank(originals);
	const [{ transactionId: first }, { transactionId: second }]: { rowId: string; transactionId: string; }[] = bank.transactions;
	const document: StoredSupportingDocument = retainedDocument(originals, 'present.pdf', 'verified bytes');
	const missing: StoredSupportingDocument = retainedDocument(originals, 'missing.pdf');
	await fs.writeFile(document.filePath, 'verified bytes');
	const decisions: Map<string, string> = new Map([[first, document.id], [second, missing.id]]);
	const approvals: Map<string, { associationRevision: number; approval: { batchId: `${string}-${string}-${string}-${string}-${string}`; approvedAt: string; transactionId: string; documentId: string; transactionRevision: number; documentRevision: number; associationRevision: number; }; }> = new Map([...decisions].map(([transactionId, documentId]: [string, string]): [string, { associationRevision: number; approval: { batchId: `${string}-${string}-${string}-${string}-${string}`; approvedAt: string; transactionId: string; documentId: string; transactionRevision: number; documentRevision: number; associationRevision: number; }; }] => [transactionId, {
		associationRevision: 1, approval: { ...approvalSelectionFor(transactionId, documentId), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00.000Z' },
	}]));
	const snapshot: SavedWorkspace = await createWorkspace(file, newMetadata(), [bank], [documentRun(originals, [document, missing])], decisions, new Map(), new Map(),
		approve ? approvals : new Map());
	return { destination, file, snapshot, first, second, document };
}

test('exports copies and their actual outcomes from the same saved snapshot', async (context: TestContext & object): Promise<void> => {
	const { destination, file, first, second, document }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const before: NonSharedBuffer = await fs.readFile(file);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	await session.dispatch({ type: 'new' });
	const workspace: () => WorkspaceView = (): WorkspaceView => session.state().workspace!;
	await assert.rejects(session.exportReconciliation(workspace().loadRevision, destination, defaultExportFilenamePattern), /save the workspace/i);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	assert.equal((await session.dispatch({ type: 'correct-bank-row', rowId: first, revision: workspace().matchRevision,
		changes: { bookingDate: '2032-02-26' } })).error, null);
	assert.equal((await session.dispatch({ type: 'review-match', transactionId: second, revision: workspace().matchRevision,
		review: { status: 'completed-without-document' } })).error, null);
	assert.equal(workspace().dirty, true);
	assert.equal(workspace().approvedDocumentCount, 0);
	await assert.rejects(session.exportReconciliation(workspace().loadRevision - 1, destination, defaultExportFilenamePattern), /workspace changed/i);
	const pending: Promise<ReconciliationExportReport> = session.exportReconciliation(workspace().loadRevision, destination, defaultExportFilenamePattern);
	await assert.rejects(session.exportReconciliation(workspace().loadRevision, destination, defaultExportFilenamePattern), /current workspace action/i);
	const result: ReconciliationExportReport = await pending;
	const reportPath: string = path.join(destination, 'reconciliation.csv');
	const documentsPath: string = path.join(destination, 'documents');
	const filename: "2032-02-28_Orchard-Workshop_EUR_-1234.56.pdf" = '2032-02-28_Orchard-Workshop_EUR_-1234.56.pdf';
	assert.deepEqual(result.csv, { status: 'written', filePath: reportPath });
	assert.equal(result.documentCopies.directory, documentsPath);
	assert.deepEqual(result.documentCopies.outcomes.map((outcome: DocumentExportOutcome): string[] => [outcome.transactionId, outcome.status]), [[first, 'copied'], [second, 'failed']]);
	assert.equal(await fs.readFile(path.join(documentsPath, filename), 'utf8'), 'verified bytes');
	const csv: string = await fs.readFile(reportPath, 'utf8');
	assert.ok(csv.includes(',copied,documents/' + filename + ',,'));
	assert.ok(csv.includes(',failed,,source-missing,'));
	assert.ok(csv.includes('2032-02-28'));
	assert.ok(!csv.includes('2032-02-26'));
	assert.equal(await fs.readFile(document.filePath, 'utf8'), 'verified bytes');
	assert.deepEqual(await fs.readFile(file), before);
	assert.equal(workspace().dirty, true);
	assert.equal(session.state().busy, false);
});

test('writes a report without creating a documents folder when no copies are approved', async (context: TestContext & object): Promise<void> => {
	const { destination, snapshot, first }: Awaited<ReturnType<typeof fixture>> = await fixture(context, false);
	const result: ReconciliationExportReport = await writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern);
	assert.deepEqual(result.documentCopies, { directory: null, outcomes: [] });
	assert.equal(result.csv.status, 'written');
	assert.deepEqual(await fs.readdir(destination), ['reconciliation.csv']);
	const csv: string = await fs.readFile(result.csv.filePath, 'utf8');
	assert.ok(csv.includes('transaction,' + first));
	assert.ok(csv.includes(',not-eligible,'));
});

test('reads approved copies from the saved relocation and keeps imported filenames in the CSV', async (context: TestContext & object): Promise<void> => {
	const { destination, snapshot, file, document, first }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const movedDirectory: string = path.join(path.dirname(destination), 'moved');
	await fs.mkdir(movedDirectory);
	const movedFile: string = path.join(movedDirectory, 'renamed.pdf');
	await fs.rename(document.filePath, movedFile);
	const sourceRelocations: Map<string, string> = new Map([[document.result.input!.source.sourceId, movedFile]]);
	await saveWorkspace(snapshot, snapshot.metadata, snapshot.imports, snapshot.documentImports, snapshot.matchDecisions, snapshot.bankCorrections,
		snapshot.documentCorrections, snapshot.reviewApprovals, snapshot.duplicateDecisions, sourceRelocations);
	const reopened: SavedWorkspace = await loadWorkspace(file);

	await assert.rejects(writeReconciliationExport(reopened, movedDirectory, defaultExportFilenamePattern), /separate from the originals/);
	const result: ReconciliationExportReport = await writeReconciliationExport(reopened, destination, defaultExportFilenamePattern);
	assert.equal(result.csv.status, 'written');
	const copied: DocumentExportOutcome = result.documentCopies.outcomes.find((outcome: DocumentExportOutcome): boolean => outcome.transactionId === first)!;
	assert.equal(copied.status, 'copied');
	assert.equal(copied.sourcePath, movedFile);
	assert.equal(await fs.readFile(path.join(result.documentCopies.directory!, copied.filename), 'utf8'), 'verified bytes');
	const csv: string = await fs.readFile(result.csv.filePath, 'utf8');
	assert.ok(csv.includes(',bank.pdf,'));
	assert.ok(csv.includes(',present.pdf,'));
	assert.ok(!csv.includes('renamed.pdf'));

	await fs.writeFile(movedFile, 'changed bytes');
	const retryDirectory: string = path.join(path.dirname(destination), 'retry');
	await fs.mkdir(retryDirectory);
	const retry: ReconciliationExportReport = await writeReconciliationExport(reopened, retryDirectory, defaultExportFilenamePattern);
	const failed: DocumentExportOutcome | undefined = retry.documentCopies.outcomes.find((outcome: DocumentExportOutcome): boolean => outcome.transactionId === first);
	assert.ok(failed?.status === 'failed');
	assert.equal(failed.reason, 'source-changed');
});

test('exports the primary booking and its approved document without the confirmed duplicate', async (context: TestContext & object): Promise<void> => {
	const root: string = await fs.mkdtemp(path.join(tmpdir(), 'receiptmatch-duplicate-export-'));
	context.onTestFinished((): Promise<void> => fs.rm(root, { recursive: true, force: true }));
	const originals: string = path.join(root, 'originals');
	const destination: string = path.join(root, 'export');
	await Promise.all([fs.mkdir(originals), fs.mkdir(destination)]);
	const first: StoredBankImport = retainedBank(originals);
	const second: StoredBankImport = retainedBank(originals);
	second.filePath = path.join(originals, 'overlapping-statement.pdf');
	const [{ transactionId: primaryId }]: { rowId: string; transactionId: string; }[] = first.transactions;
	const [{ transactionId: excludedId }]: { rowId: string; transactionId: string; }[] = second.transactions;
	const document: StoredSupportingDocument = retainedDocument(originals, 'primary.pdf', 'primary bytes');
	const archived: StoredSupportingDocument = retainedDocument(originals, 'archived.pdf', 'archived bytes');
	const input: BankImportInput = document.result.input!;
	input.pages[0].spans = input.pages[0].spans.map((span: PositionedSpan): PositionedSpan => ({
		...span, text: span.text.replace('SYNTHETIC-ONLY', 'SYNTHETIC-A').replace('9007199254740993.27', '1,234.56'),
	}));
	document.result = interpretSupportingDocument(input);
	await Promise.all([fs.writeFile(document.filePath, 'primary bytes'), fs.writeFile(archived.filePath, 'archived bytes')]);
	const approvals: Map<string, ReviewApprovalState> = new Map<string, ReviewApprovalState>([[primaryId, document.id], [excludedId, archived.id]].map(([transactionId, documentId]: string[]): [string, { associationRevision: number; approval: { batchId: `${string}-${string}-${string}-${string}-${string}`; approvedAt: string; transactionId: string; documentId: string; transactionRevision: number; documentRevision: number; associationRevision: number; }; }] => [transactionId, {
		associationRevision: 1, approval: { ...approvalSelectionFor(transactionId, documentId), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00.000Z' },
	}]));
	approvals.set(excludedId, advanceReviewRevision(approvals.get(excludedId)));
	const [firstId, secondId]: string[] = [primaryId, excludedId].sort();
	const duplicates: Map<string, { firstId: string; secondId: string; primaryId: string; archivedReview: { documentId: string; }; }> = new Map([[duplicatePairKey(firstId, secondId), { firstId, secondId, primaryId, archivedReview: { documentId: archived.id } }]]);
	const file: string = path.join(root, 'workspace.receiptmatch');
	await createWorkspace(file, newMetadata(), [first, second], [documentRun(originals, [document, archived])],
		new Map([[primaryId, document.id]]), new Map(), new Map(), approvals, duplicates);
	const snapshot: SavedWorkspace = await loadWorkspace(file);

	assert.equal(snapshot.matches.find((match: TransactionMatch): boolean => match.transactionId === primaryId)?.status, 'uncertain');
	assert.ok(snapshot.matches.some((match: TransactionMatch): boolean => match.transactionId === excludedId));
	const rows: import('../../electron/reconciliation-csv.js').ReconciliationRow[] = reconciliationRows(snapshot);
	assert.deepEqual(rows.map((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): string => row.transaction_id), [
		...first.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId), ...second.transactions.slice(1).map((row: { rowId: string; transactionId: string; }): string => row.transactionId),
	]);
	assert.equal(rows[0].match_status, 'reliable');
	assert.equal(rows[0].approval_status, 'approved');
	const result: ReconciliationExportReport = await writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern);
	assert.equal(result.csv.status, 'written');
	assert.deepEqual(result.documentCopies.outcomes.map((outcome: DocumentExportOutcome): string[] => [outcome.transactionId, outcome.documentId, outcome.status]),
		[[primaryId, document.id, 'copied']]);
	const csv: string = await fs.readFile(result.csv.filePath, 'utf8');
	assert.ok(csv.includes('transaction,' + primaryId));
	assert.ok(!csv.includes('transaction,' + excludedId));
	assert.ok(!csv.includes(archived.id));
	assert.equal(await fs.readFile(archived.filePath, 'utf8'), 'archived bytes');
});

test('stops before copying when reconciliation.csv already exists', async (context: TestContext & object): Promise<void> => {
	const { destination, snapshot, document }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	await assert.rejects(writeReconciliationExport(snapshot, path.dirname(document.filePath), defaultExportFilenamePattern), /separate from the originals/);
	const reportPath: string = path.join(destination, 'reconciliation.csv');
	await fs.writeFile(reportPath, 'existing report');
	await assert.rejects(writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern), /reconciliation\.csv already exists/);
	assert.deepEqual(await fs.readdir(destination), ['reconciliation.csv']);
	assert.equal(await fs.readFile(reportPath, 'utf8'), 'existing report');
});

test.for(['collision', 'write-failed', 'collision-with-cleanup-error'] as const)('keeps copy outcomes when final CSV publication reports %s', async (failure: "collision" | "write-failed" | "collision-with-cleanup-error", context: TestContext & object): Promise<void> => {
	const { destination, snapshot }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const reportPath: string = path.join(destination, 'reconciliation.csv');
	const collision: boolean = failure !== 'write-failed';
	const cleanupFailed: boolean = failure === 'collision-with-cleanup-error';
	const realLink: (existingPath: PathLike, newPath: PathLike) => Promise<void> = fs.link;
	const link: Mock<(existingPath: PathLike, newPath: PathLike) => Promise<void>> = vi.spyOn(fs, 'link').mockImplementation(async (existing: PathLike, target: PathLike): Promise<void> => {
		if (target === reportPath) {
			if (!collision) {
				throw Object.assign(new Error('Simulated write failure'), { code: 'EIO' });
			}
			await fs.writeFile(reportPath, 'concurrent report', { flag: 'wx' });
		}
		await realLink(existing, target);
	});
	const realUnlink: (path: PathLike) => Promise<void> = fs.unlink;
	const unlink: Mock<(path: PathLike) => Promise<void>> = vi.spyOn(fs, 'unlink').mockImplementation(async (file: PathLike): Promise<void> => {
		if (cleanupFailed && path.dirname(String(file)) === destination && path.basename(String(file)).startsWith('.receiptmatch-')) {
			throw Object.assign(new Error('Simulated cleanup failure'), { code: 'EACCES' });
		}
		await realUnlink(file);
	});
	syncBuiltinESMExports();
	try {
		const result: ReconciliationExportReport = await writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern);
		assert.deepEqual(result.csv, { filePath: reportPath, status: 'failed', reason: collision ? 'collision' : 'write-failed',
			...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) });
		assert.deepEqual(result.documentCopies.outcomes.map((outcome: DocumentExportOutcome): "failed" | "skipped" | "copied" => outcome.status), ['copied', 'failed']);
		assert.deepEqual(await fs.readdir(result.documentCopies.directory!), ['2032-02-28_Orchard-Workshop_EUR_-1234.56.pdf']);
		const entries: string[] = await fs.readdir(destination);
		assert.deepEqual(entries.filter((entry: string): boolean => !entry.startsWith('.receiptmatch-')).sort(), collision ? ['documents', 'reconciliation.csv'] : ['documents']);
		assert.equal(entries.filter((entry: string): boolean => entry.startsWith('.receiptmatch-')).length, cleanupFailed ? 1 : 0);
		if (collision) {
			assert.equal(await fs.readFile(reportPath, 'utf8'), 'concurrent report');
		}
	} finally {
		unlink.mockRestore();
		link.mockRestore();
		syncBuiltinESMExports();
	}
});

test('persists an ignored booking, suppresses it from matching and exports, and restores its approval on undo', async (context: TestContext & object): Promise<void> => {
	const { destination, file, snapshot, first, second, document }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const reopen: () => Promise<WorkspaceSession> = async (): Promise<WorkspaceSession> => {
		const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
		assert.equal((await session.dispatch({ type: 'open' })).error, null);
		return session;
	};
	const session: WorkspaceSession = await reopen();
	const workspace: () => WorkspaceView = (): WorkspaceView => session.state().workspace!;
	const revision: number = workspace().matchRevision;
	const initialApproval: MatchApprovalSelection = session.matchSummaries(revision)!.find((row: MatchSummary): boolean => row.transactionId === first)!.approvalSelection!;
	assert.equal((await session.dispatch({ type: 'set-transaction-ignored', revision, transactionId: first, ignored: true })).error, null);
	assert.equal(workspace().dirty, true);
	assert.equal(workspace().approvedDocumentCount, 1);
	assert.equal(session.matchSummaries(revision), null);
	assert.equal(session.matchDetails(workspace().matchRevision, first), null);
	assert.match((await session.dispatch({ type: 'set-transaction-ignored', revision, transactionId: first, ignored: false })).error ?? '', /changed/i);
	assert.match((await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: first, review: { status: 'open' } })).error ?? '', /no longer available/i);
	assert.match((await session.dispatch({ type: 'approve-matches', loadRevision: workspace().loadRevision, selections: [initialApproval] })).error ?? '', /no assigned document/i);
	assert.deepEqual((await session.exportApprovedDocuments(workspace().loadRevision, destination, defaultExportFilenamePattern)).outcomes.map((row: DocumentExportOutcome): string => row.transactionId), [second]);
	assert.equal((await loadWorkspace(file)).ignoredTransactions.size, 0);

	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved: SavedWorkspace = await loadWorkspace(file);
	assert.deepEqual(saved.ignoredTransactions, new Set([first]));
	assert.deepEqual(saved.imports, snapshot.imports);
	assert.equal(saved.matchDecisions.get(first), document.id);
	assert.deepEqual(saved.reviewApprovals, snapshot.reviewApprovals);
	const csv: import('../../electron/reconciliation-csv.js').ReconciliationRow = reconciliationRows(saved).find((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): boolean => row.transaction_id === first)!;
	assert.equal(csv.review_status, 'ignored');
	assert.equal(csv.match_status, '');
	assert.equal(csv.approval_batch_id, '');
	assert.equal(csv.copy_status, 'not-eligible');
	const exportReport: ReconciliationExportReport = await writeReconciliationExport(saved, destination, defaultExportFilenamePattern);
	assert.deepEqual(exportReport.documentCopies.outcomes.map((row: DocumentExportOutcome): string => row.transactionId), [second]);

	const reopened: WorkspaceSession = await reopen();
	const reopenedState: WorkspaceView = reopened.state().workspace!;
	const ignored: MatchSummary = reopened.matchSummaries(reopenedState.matchRevision)!.find((row: MatchSummary): boolean => row.transactionId === first)!;
	assert.equal(ignored.ignored, true);
	assert.equal(ignored.candidateCount, 0);
	assert.equal(ignored.approval, null);
	assert.equal((await reopened.dispatch({ type: 'set-transaction-ignored', revision: reopenedState.matchRevision, transactionId: first, ignored: false })).error, null);
	const restored: MatchSummary = reopened.matchSummaries(reopened.state().workspace!.matchRevision)!.find((row: MatchSummary): boolean => row.transactionId === first)!;
	assert.equal(restored.ignored, false);
	assert.deepEqual(restored.review, { status: 'assigned', documentId: document.id });
	assert.deepEqual(restored.approval, snapshot.reviewApprovals.get(first)?.approval);
	assert.equal((await reopened.dispatch({ type: 'save' })).error, null);
	assert.equal((await loadWorkspace(file)).ignoredTransactions.size, 0);
});

test('applies and removes a local ignore rule across workspaces and keeps independent one-time ignores', async (context: TestContext & object): Promise<void> => {
	const { file, destination, snapshot, first, second }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const root: string = path.dirname(file);
	const rules: string = path.join(root, 'transaction-ignore-rules');
	const input: BankImportInput = statement();
	const spans: PositionedSpan[] = input.pages[0].spans;
	spans.find((span: PositionedSpan): boolean => span.text === 'To: Orchard Workshop')!.text = 'TO: ORCHARD   WORKSHOP';
	spans.find((span: PositionedSpan): boolean => span.text === '1,234.56')!.text = '35.50';
	const nextBank: StoredBankImport = retainedBank(root, input);
	const differentCurrency: StoredBankImport = retainedBank(root);
	differentCurrency.result.accountSections[0].currency.value = 'USD';
	for (const row of differentCurrency.result.transactions) {
		row.accountAmount.value.currency = 'USD';
	}
	const differentDirectionInput: BankImportInput = statement();
	const payment: PositionedSpan = differentDirectionInput.pages[0].spans.find((span: PositionedSpan): boolean => span.text === '1,234.56')!;
	payment.region.x = 437;
	differentDirectionInput.pages[0].spans = differentDirectionInput.pages[0].spans.filter((span: PositionedSpan): boolean => !span.text.startsWith('Original amount:'));
	const differentDirection: StoredBankImport = retainedBank(root, differentDirectionInput);
	assert.equal(differentDirection.result.transactions[0].direction, 'incoming');
	const differentDescriptionInput: BankImportInput = statement();
	differentDescriptionInput.pages[0].spans.find((span: PositionedSpan): boolean => span.text === 'To: Orchard Workshop')!.text = 'To: Orchard Workshop Annex';
	const differentDescription: StoredBankImport = retainedBank(root, differentDescriptionInput);
	const future: string = path.join(root, 'future.receiptmatch');
	const [{ transactionId: matching }]: { rowId: string; transactionId: string; }[] = nextBank.transactions;
	const [{ transactionId: independentlyIgnored }]: { rowId: string; transactionId: string; }[] = differentCurrency.transactions;
	const banks: StoredBankImport[] = [nextBank, differentCurrency, differentDirection, differentDescription];
	for (const [index, bank] of banks.entries()) {
		bank.filePath = path.join(root, 'bank-' + index + '.pdf');
	}
	const next: SavedWorkspace = await createWorkspace(future, newMetadata(), banks);
	await saveWorkspace(next, next.metadata, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		new Set([independentlyIgnored]));

	const newlyImported: StoredBankImport = retainedBank(root, statement());
	newlyImported.filePath = path.join(root, 'newly-imported.pdf');
	const open: (workspaceFile: string) => Promise<WorkspaceSession> = async (workspaceFile: string): Promise<WorkspaceSession> => {
		const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(workspaceFile), save: async (): Promise<string> => Promise.resolve(workspaceFile), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') },
			undefined, { run: async (): Promise<{ status: "imported"; record: StoredBankImport; }> => Promise.resolve(({ status: 'imported', record: newlyImported })) }, undefined, undefined, rules);
		assert.equal((await session.dispatch({ type: 'open' })).error, null);
		return session;
	};

	const summary: (session: WorkspaceSession, id: string) => MatchSummary = (session: WorkspaceSession, id: string): MatchSummary =>
		session.matchSummaries(session.state().workspace!.matchRevision)!.find((row: MatchSummary): boolean => row.transactionId === id)!;

	const setIgnored: (session: WorkspaceSession, transactionId: string, ignored: boolean, remember?: true) => Promise<WorkspaceState> = (session: WorkspaceSession, transactionId: string, ignored: boolean, remember?: true): Promise<WorkspaceState> =>
		session.dispatch({ type: 'set-transaction-ignored', revision: session.state().workspace!.matchRevision, transactionId, ignored, ...(remember && { remember }) });

	const original: WorkspaceSession = await open(file);
	assert.equal((await setIgnored(original, first, true, true)).error, null);
	assert.equal(original.state().workspace!.dirty, false);
	assert.equal(original.state().workspace!.approvedDocumentCount, 1);
	assert.equal(summary(original, first).ignoredByRule, true);
	assert.equal(summary(original, second).ignored, false);
	const report: ReconciliationExportReport = await original.exportReconciliation(original.state().workspace!.loadRevision, destination, defaultExportFilenamePattern);
	assert.deepEqual(report.documentCopies.outcomes.map((outcome: DocumentExportOutcome): string => outcome.transactionId), [second]);
	const csv: string = await fs.readFile(path.join(destination, 'reconciliation.csv'), 'utf8');
	assert.match(csv, new RegExp(first + '.*?,ignored,', 's'));
	assert.deepEqual((await loadWorkspace(file)).ignoredTransactions, snapshot.ignoredTransactions);

	const reopened: WorkspaceSession = await open(future);
	assert.equal(summary(reopened, matching).ignoredByRule, true);
	assert.equal((await reopened.dispatch({ type: 'import-statement' })).importOutcome?.status, 'imported');
	const newlyImportedId: string = newlyImported.transactions[0].transactionId;
	assert.equal(summary(reopened, newlyImportedId).ignoredByRule, true);
	assert.equal(summary(reopened, independentlyIgnored).ignored, true);
	assert.equal(summary(reopened, independentlyIgnored).ignoredByRule, false);
	assert.equal(summary(reopened, differentDirection.transactions[0].transactionId).ignored, false);
	assert.equal(summary(reopened, differentDescription.transactions[0].transactionId).ignored, false);
	assert.equal((await setIgnored(reopened, matching, false)).error, null);
	assert.equal(summary(reopened, matching).ignored, false);
	assert.equal(summary(reopened, newlyImportedId).ignored, false);
	assert.equal(summary(reopened, independentlyIgnored).ignored, true);
	const restored: WorkspaceSession = await open(file);
	assert.equal(summary(restored, first).ignored, false);
	assert.equal(restored.state().workspace!.approvedDocumentCount, 2);
});
