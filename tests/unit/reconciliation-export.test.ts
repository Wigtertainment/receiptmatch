import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi, type TestContext } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { reconciliationRows } from '../../electron/reconciliation-csv.js';
import { writeReconciliationExport } from '../../electron/reconciliation-export.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { defaultExportFilenamePattern } from '../../src/shared/export-filename.js';
import { advanceReviewRevision, approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { duplicatePairKey } from '../../src/shared/transaction-duplicates.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

async function fixture(context: TestContext, approve = true) {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'receiptmatch-reconciliation-export-'));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	const originals = path.join(root, 'originals');
	const destination = path.join(root, 'export');
	await Promise.all([fs.mkdir(originals), fs.mkdir(destination)]);
	const file = path.join(root, 'workspace.receiptmatch');
	const bank = retainedBank(originals);
	const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
	const document = retainedDocument(originals, 'present.pdf', 'verified bytes');
	const missing = retainedDocument(originals, 'missing.pdf');
	await fs.writeFile(document.filePath, 'verified bytes');
	const decisions = new Map([[first, document.id], [second, missing.id]]);
	const approvals = new Map([...decisions].map(([transactionId, documentId]) => [transactionId, {
		associationRevision: 1, approval: { ...approvalSelectionFor(transactionId, documentId), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00.000Z' },
	}]));
	const snapshot = await createWorkspace(file, newMetadata(), [bank], [documentRun(originals, [document, missing])], decisions, new Map(), new Map(),
		approve ? approvals : new Map());
	return { destination, file, snapshot, first, second, document };
}

test('exports copies and their actual outcomes from the same saved snapshot', async context => {
	const { destination, file, first, second, document } = await fixture(context);
	const before = await fs.readFile(file);
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	await session.dispatch({ type: 'new' });
	const workspace = () => session.state().workspace!;
	await assert.rejects(session.exportReconciliation(workspace().loadRevision, destination, defaultExportFilenamePattern), /save the workspace/i);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	assert.equal((await session.dispatch({ type: 'correct-bank-row', rowId: first, revision: workspace().matchRevision,
		changes: { bookingDate: '2032-02-26' } })).error, null);
	assert.equal((await session.dispatch({ type: 'review-match', transactionId: second, revision: workspace().matchRevision,
		review: { status: 'completed-without-document' } })).error, null);
	assert.equal(workspace().dirty, true);
	assert.equal(workspace().approvedDocumentCount, 0);
	await assert.rejects(session.exportReconciliation(workspace().loadRevision - 1, destination, defaultExportFilenamePattern), /workspace changed/i);
	const pending = session.exportReconciliation(workspace().loadRevision, destination, defaultExportFilenamePattern);
	await assert.rejects(session.exportReconciliation(workspace().loadRevision, destination, defaultExportFilenamePattern), /current workspace action/i);
	const result = await pending;
	const reportPath = path.join(destination, 'reconciliation.csv');
	const documentsPath = path.join(destination, 'documents');
	const filename = '2032-02-28_Orchard-Workshop_EUR_-1234.56.pdf';
	assert.deepEqual(result.csv, { status: 'written', filePath: reportPath });
	assert.equal(result.documentCopies.directory, documentsPath);
	assert.deepEqual(result.documentCopies.outcomes.map(outcome => [outcome.transactionId, outcome.status]), [[first, 'copied'], [second, 'failed']]);
	assert.equal(await fs.readFile(path.join(documentsPath, filename), 'utf8'), 'verified bytes');
	const csv = await fs.readFile(reportPath, 'utf8');
	assert.ok(csv.includes(',copied,documents/' + filename + ',,'));
	assert.ok(csv.includes(',failed,,source-missing,'));
	assert.ok(csv.includes('2032-02-28'));
	assert.ok(!csv.includes('2032-02-26'));
	assert.equal(await fs.readFile(document.filePath, 'utf8'), 'verified bytes');
	assert.deepEqual(await fs.readFile(file), before);
	assert.equal(workspace().dirty, true);
	assert.equal(session.state().busy, false);
});

test('writes a report without creating a documents folder when no copies are approved', async context => {
	const { destination, snapshot, first } = await fixture(context, false);
	const result = await writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern);
	assert.deepEqual(result.documentCopies, { directory: null, outcomes: [] });
	assert.equal(result.csv.status, 'written');
	assert.deepEqual(await fs.readdir(destination), ['reconciliation.csv']);
	const csv = await fs.readFile(result.csv.filePath, 'utf8');
	assert.ok(csv.includes('transaction,' + first));
	assert.ok(csv.includes(',not-eligible,'));
});

test('reads approved copies from the saved relocation and keeps imported filenames in the CSV', async context => {
	const { destination, snapshot, file, document, first } = await fixture(context);
	const movedDirectory = path.join(path.dirname(destination), 'moved');
	await fs.mkdir(movedDirectory);
	const movedFile = path.join(movedDirectory, 'renamed.pdf');
	await fs.rename(document.filePath, movedFile);
	const sourceRelocations = new Map([[document.result.input!.source.sourceId, movedFile]]);
	await saveWorkspace(snapshot, snapshot.metadata, snapshot.imports, snapshot.documentImports, snapshot.matchDecisions, snapshot.bankCorrections,
		snapshot.documentCorrections, snapshot.reviewApprovals, snapshot.duplicateDecisions, sourceRelocations);
	const reopened = await loadWorkspace(file);

	await assert.rejects(writeReconciliationExport(reopened, movedDirectory, defaultExportFilenamePattern), /separate from the originals/);
	const result = await writeReconciliationExport(reopened, destination, defaultExportFilenamePattern);
	assert.equal(result.csv.status, 'written');
	const copied = result.documentCopies.outcomes.find(outcome => outcome.transactionId === first)!;
	assert.equal(copied.status, 'copied');
	assert.equal(copied.sourcePath, movedFile);
	assert.equal(await fs.readFile(path.join(result.documentCopies.directory!, copied.filename!), 'utf8'), 'verified bytes');
	const csv = await fs.readFile(result.csv.filePath, 'utf8');
	assert.ok(csv.includes(',bank.pdf,'));
	assert.ok(csv.includes(',present.pdf,'));
	assert.ok(!csv.includes('renamed.pdf'));

	await fs.writeFile(movedFile, 'changed bytes');
	const retryDirectory = path.join(path.dirname(destination), 'retry');
	await fs.mkdir(retryDirectory);
	const retry = await writeReconciliationExport(reopened, retryDirectory, defaultExportFilenamePattern);
	const failed = retry.documentCopies.outcomes.find(outcome => outcome.transactionId === first);
	assert.ok(failed?.status === 'failed');
	assert.equal(failed.reason, 'source-changed');
});

test('exports the primary booking and its approved document without the confirmed duplicate', async context => {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'receiptmatch-duplicate-export-'));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	const originals = path.join(root, 'originals');
	const destination = path.join(root, 'export');
	await Promise.all([fs.mkdir(originals), fs.mkdir(destination)]);
	const first = retainedBank(originals);
	const second = retainedBank(originals);
	second.filePath = path.join(originals, 'overlapping-statement.pdf');
	const [{ transactionId: primaryId }] = first.transactions;
	const [{ transactionId: excludedId }] = second.transactions;
	const document = retainedDocument(originals, 'primary.pdf', 'primary bytes');
	const archived = retainedDocument(originals, 'archived.pdf', 'archived bytes');
	const input = document.result.input!;
	input.pages[0].spans = input.pages[0].spans.map(span => ({
		...span, text: span.text.replace('SYNTHETIC-ONLY', 'SYNTHETIC-A').replace('9007199254740993.27', '1,234.56'),
	}));
	document.result = interpretSupportingDocument(input);
	await Promise.all([fs.writeFile(document.filePath, 'primary bytes'), fs.writeFile(archived.filePath, 'archived bytes')]);
	const approvals = new Map<string, ReviewApprovalState>([[primaryId, document.id], [excludedId, archived.id]].map(([transactionId, documentId]) => [transactionId, {
		associationRevision: 1, approval: { ...approvalSelectionFor(transactionId, documentId), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00.000Z' },
	}]));
	approvals.set(excludedId, advanceReviewRevision(approvals.get(excludedId)));
	const [firstId, secondId] = [primaryId, excludedId].sort();
	const duplicates = new Map([[duplicatePairKey(firstId, secondId), { firstId, secondId, primaryId, archivedReview: { documentId: archived.id } }]]);
	const file = path.join(root, 'workspace.receiptmatch');
	await createWorkspace(file, newMetadata(), [first, second], [documentRun(originals, [document, archived])],
		new Map([[primaryId, document.id]]), new Map(), new Map(), approvals, duplicates);
	const snapshot = await loadWorkspace(file);

	assert.equal(snapshot.matches.find(match => match.transactionId === primaryId)?.status, 'uncertain');
	assert.ok(snapshot.matches.some(match => match.transactionId === excludedId));
	const rows = reconciliationRows(snapshot);
	assert.deepEqual(rows.map(row => row.transaction_id), [
		...first.transactions.map(row => row.transactionId), ...second.transactions.slice(1).map(row => row.transactionId),
	]);
	assert.equal(rows[0].match_status, 'reliable');
	assert.equal(rows[0].approval_status, 'approved');
	const result = await writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern);
	assert.equal(result.csv.status, 'written');
	assert.deepEqual(result.documentCopies.outcomes.map(outcome => [outcome.transactionId, outcome.documentId, outcome.status]),
		[[primaryId, document.id, 'copied']]);
	const csv = await fs.readFile(result.csv.filePath, 'utf8');
	assert.ok(csv.includes('transaction,' + primaryId));
	assert.ok(!csv.includes('transaction,' + excludedId));
	assert.ok(!csv.includes(archived.id));
	assert.equal(await fs.readFile(archived.filePath, 'utf8'), 'archived bytes');
});

test('stops before copying when reconciliation.csv already exists', async context => {
	const { destination, snapshot, document } = await fixture(context);
	await assert.rejects(writeReconciliationExport(snapshot, path.dirname(document.filePath), defaultExportFilenamePattern), /separate from the originals/);
	const reportPath = path.join(destination, 'reconciliation.csv');
	await fs.writeFile(reportPath, 'existing report');
	await assert.rejects(writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern), /reconciliation\.csv already exists/);
	assert.deepEqual(await fs.readdir(destination), ['reconciliation.csv']);
	assert.equal(await fs.readFile(reportPath, 'utf8'), 'existing report');
});

test.for(['collision', 'write-failed', 'collision-with-cleanup-error'] as const)('keeps copy outcomes when final CSV publication reports %s', async (failure, context) => {
	const { destination, snapshot } = await fixture(context);
	const reportPath = path.join(destination, 'reconciliation.csv');
	const collision = failure !== 'write-failed';
	const cleanupFailed = failure === 'collision-with-cleanup-error';
	const realLink = fs.link;
	const link = vi.spyOn(fs, 'link').mockImplementation(async (existing, target) => {
		if (target === reportPath) {
			if (!collision) throw Object.assign(new Error('Simulated write failure'), { code: 'EIO' });
			await fs.writeFile(reportPath, 'concurrent report', { flag: 'wx' });
		}
		await realLink(existing, target);
	});
	const realUnlink = fs.unlink;
	const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
		if (cleanupFailed && path.dirname(String(file)) === destination && path.basename(String(file)).startsWith('.receiptmatch-')) {
			throw Object.assign(new Error('Simulated cleanup failure'), { code: 'EACCES' });
		}
		await realUnlink(file);
	});
	syncBuiltinESMExports();
	try {
		const result = await writeReconciliationExport(snapshot, destination, defaultExportFilenamePattern);
		assert.deepEqual(result.csv, { filePath: reportPath, status: 'failed', reason: collision ? 'collision' : 'write-failed',
			...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) });
		assert.deepEqual(result.documentCopies.outcomes.map(outcome => outcome.status), ['copied', 'failed']);
		assert.deepEqual(await fs.readdir(result.documentCopies.directory!), ['2032-02-28_Orchard-Workshop_EUR_-1234.56.pdf']);
		const entries = await fs.readdir(destination);
		assert.deepEqual(entries.filter(entry => !entry.startsWith('.receiptmatch-')).sort(), collision ? ['documents', 'reconciliation.csv'] : ['documents']);
		assert.equal(entries.filter(entry => entry.startsWith('.receiptmatch-')).length, cleanupFailed ? 1 : 0);
		if (collision) assert.equal(await fs.readFile(reportPath, 'utf8'), 'concurrent report');
	} finally {
		unlink.mockRestore();
		link.mockRestore();
		syncBuiltinESMExports();
	}
});
