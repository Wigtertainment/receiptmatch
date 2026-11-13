import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata, SCHEMA_VERSION } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { defaultExportFilenamePattern } from '../../src/shared/export-filename.js';
import { approvalSelectionFor } from '../../src/shared/match-approvals.js';
import type { OriginalPreviewRequest } from '../../src/shared/original-preview.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

async function fixture(context: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-source-relink-'));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const originals = path.join(root, 'originals'), moved = path.join(root, 'moved');
	const docsExport = path.join(root, 'copy'), csvExport = path.join(root, 'export');
	await Promise.all([originals, moved, docsExport, csvExport].map(directory => mkdir(directory)));
	const bank = retainedBank(originals);
	const receipt = retainedDocument(originals, 'receipt.pdf', 'approved synthetic bytes');
	const bankBytes = 'original synthetic statement';
	bank.result.sourceProvenance!.sha256 = createHash('sha256').update(bankBytes).digest('hex');
	const bankPath = path.join(moved, 'renamed-statement.pdf'), receiptPath = path.join(moved, 'renamed-receipt.pdf');
	await Promise.all([writeFile(bank.filePath, bankBytes), writeFile(receipt.filePath, 'approved synthetic bytes')]);
	await Promise.all([rename(bank.filePath, bankPath), rename(receipt.filePath, receiptPath)]);
	const transactionId = bank.transactions[0].transactionId;
	const approvals = new Map([[transactionId, { associationRevision: 1, approval: {
		...approvalSelectionFor(transactionId, receipt.id), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z',
	} }]]);
	const file = path.join(root, 'relink.receiptmatch');
	const docs = [documentRun(originals, [receipt])];
	await createWorkspace(file, newMetadata(), [bank], docs, new Map([[transactionId, receipt.id]]), new Map(), new Map(), approvals);
	let selected: string | null = null;
	let calls = 0;
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard',
		relinkOriginal: async () => { calls++; return selected; } });
	await session.dispatch({ type: 'open' });
	const state = () => session.state().workspace!;
	const request = (kind: OriginalPreviewRequest['kind']): OriginalPreviewRequest =>
		({ kind, id: kind === 'statement' ? bank.id : receipt.id, loadRevision: state().loadRevision });
	const relink = (kind: OriginalPreviewRequest['kind'], target: string | null) => { selected = target; return session.relinkOriginal(request(kind)); };
	return { root, file, bank, receipt, docs, bankPath, receiptPath, docsExport, csvExport, session, state, request, relink, approvals, calls: () => calls };
}

test('relinks both source types, preserves provenance and approval, and uses the saved path for export', async (context) => {
	const { file, bank, receipt, docs, bankPath, receiptPath, docsExport, csvExport, session, state, request, relink, approvals } = await fixture(context);
	const before = await readFile(file);
	const revision = state().matchRevision;
	assert.equal(state().approvedDocumentCount, 1);
	assert.equal(session.originalSource(request('statement'))?.filePath, bank.filePath);
	assert.deepEqual(await relink('statement', bankPath), { status: 'linked' });
	assert.deepEqual(await relink('document', receiptPath), { status: 'linked' });
	assert.equal(state().dirty, true);
	assert.equal(state().matchRevision, revision);
	assert.equal(state().approvedDocumentCount, 1);
	assert.equal(session.originalSource(request('statement'))?.filePath, bankPath);
	assert.equal(session.originalSource(request('document'))?.filePath, receiptPath);
	assert.deepEqual(session.bankImports(), [bank]);
	assert.deepEqual(session.documentImports(), docs);
	assert.deepEqual(await readFile(file), before);
	const copy = await session.exportApprovedDocuments(state().loadRevision, docsExport, defaultExportFilenamePattern);
	assert.equal(copy.outcomes[0].status, 'copied');
	assert.equal(copy.outcomes[0].sourcePath, receiptPath);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal(state().dirty, false);
	const saved = await loadWorkspace(file);
	assert.equal(saved.sourceRelocations.get(bank.result.sourceProvenance!.sourceId), bankPath);
	assert.equal(saved.sourceRelocations.get(receipt.result.input!.source.sourceId), receiptPath);
	assert.deepEqual(saved.reviewApprovals, approvals);
	await session.dispatch({ type: 'open' });
	assert.equal(session.originalSource(request('document'))?.filePath, receiptPath);
	const exported = await session.exportReconciliation(state().loadRevision, csvExport, defaultExportFilenamePattern);
	assert.equal(exported.csv.status, 'written');
	assert.equal(exported.documentCopies.outcomes[0].status, 'copied');
	const csv = await readFile(exported.csv.filePath, 'utf8');
	assert.ok(csv.includes('bank.pdf') && csv.includes('receipt.pdf'));
	assert.ok(!csv.includes('renamed-'));
	assert.equal(await readFile(receiptPath, 'utf8'), 'approved synthetic bytes');
});

test('rejects altered files and stale requests and leaves cancellation and previous links intact', async (context) => {
	const { root, file, receipt, receiptPath, session, state, request, relink, calls } = await fixture(context);
	const before = await readFile(file);
	const replacement = path.join(root, 'altered.pdf');
	await writeFile(replacement, 'different document');
	assert.deepEqual(await relink('document', null), { status: 'cancelled' });
	assert.equal((await relink('document', replacement)).status, 'failed');
	assert.equal(state().dirty, false);
	assert.equal(session.originalSource(request('document'))?.filePath, receipt.filePath);
	const beforeStale = calls();
	assert.equal((await session.relinkOriginal({ ...request('document'), loadRevision: state().loadRevision - 1 })).status, 'failed');
	assert.equal(calls(), beforeStale);
	assert.deepEqual(await relink('document', receiptPath), { status: 'linked' });
	assert.equal((await relink('document', replacement)).status, 'failed');
	assert.equal(session.originalSource(request('document'))?.filePath, receiptPath);
	await rename(receiptPath, receipt.filePath);
	assert.deepEqual(await relink('document', receipt.filePath), { status: 'linked' });
	assert.equal(state().dirty, false);
	assert.deepEqual(await readFile(file), before);
});

test('opens a version 9 workspace and migrates its source links only on save', async (context) => {
	const { file, session, receiptPath, relink, state } = await fixture(context);
	const database = new Database(file);
	try { database.exec('DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; PRAGMA user_version=9;'); }
	finally { database.close(); }
	const before = await readFile(file);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	assert.equal(state().dirty, false);
	assert.deepEqual(await relink('document', receiptPath), { status: 'linked' });
	assert.deepEqual(await readFile(file), before);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual([...saved.sourceRelocations.values()], [receiptPath]);
});
