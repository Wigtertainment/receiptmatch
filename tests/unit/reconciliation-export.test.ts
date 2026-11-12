import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi, type TestContext } from 'vitest';
import { writeReconciliationExport } from '../../electron/reconciliation-export.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { defaultExportFilenamePattern } from '../../src/shared/export-filename.js';
import { approvalSelectionFor } from '../../src/shared/match-approvals.js';
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
