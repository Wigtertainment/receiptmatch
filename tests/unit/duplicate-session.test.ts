import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata, SCHEMA_VERSION } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { approvalSelectionFor } from '../../src/shared/match-approvals.js';
import type { WorkspaceCommand } from '../../src/shared/protocol.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

async function fixture(context: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-duplicates-'));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const file = path.join(root, 'test.receiptmatch');
	const banks = Array.from({ length: 3 }, (_, index) => {
		const record = retainedBank(root);
		record.filePath = path.join(root, `statement-${index}.pdf`);
		record.transactions = record.transactions.slice(0, 1);
		record.result.transactions = record.result.transactions.slice(0, 1);
		return record;
	});
	const [firstId, secondId, thirdId] = banks.map(bank => bank.transactions[0].transactionId);
	const receipts = [retainedDocument(root, 'first.pdf'), retainedDocument(root, 'second.pdf')];
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	const decide = (decision: Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>['decision'],
		transactionId = firstId, otherTransactionId = secondId, revision = session.state().workspace!.matchRevision) =>
		session.dispatch({ type: 'set-duplicate-decision', revision, transactionId, otherTransactionId, decision });
	const summaries = () => new Map(session.matchSummaries(session.state().workspace!.matchRevision)!.map(row => [row.transactionId, row]));
	return { root, file, banks, firstId, secondId, thirdId, receipts, session, decide, summaries };
}

test('archives an excluded review, revokes only its approval and restores the review after reopening and undo', async (context) => {
	const { root, file, banks, firstId, secondId, receipts, session, decide, summaries } = await fixture(context);
	const [firstDocument, secondDocument] = receipts.map(receipt => receipt.id);
	const decisions = new Map([[firstId, firstDocument], [secondId, secondDocument]]);
	const approvals = new Map([...decisions].map(([id, doc]) => [id, {
		associationRevision: 1, approval: { ...approvalSelectionFor(id, doc), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z' },
	}]));
	await createWorkspace(file, newMetadata(), banks, [documentRun(root, receipts)], decisions, new Map(), new Map(), approvals);
	const bytes = await readFile(file);
	await session.dispatch({ type: 'open' });
	assert.equal(summaries().get(secondId)?.approvalStatus.status, 'approved');
	const separate = await decide('separate');
	assert.equal(separate.error, null);
	assert.equal(separate.workspace?.duplicateDecisions[0].primaryId, null);
	assert.equal(summaries().size, 3);
	assert.equal((await decide('clear')).error, null);
	const excluded = await decide('keep-first');
	assert.equal(excluded.error, null);
	assert.equal(excluded.workspace?.duplicateDecisions[0].primaryId, firstId);
	assert.deepEqual(excluded.workspace?.duplicateDecisions[0].archivedReview, { documentId: secondDocument });
	assert.equal(excluded.workspace?.approvedDocumentCount, 1);
	assert.equal(summaries().has(secondId), false);
	assert.equal(summaries().get(firstId)?.approvalStatus.status, 'approved');
	assert.equal(session.matchDetails(excluded.workspace!.matchRevision, secondId), null);
	assert.deepEqual(session.bankImports(), banks);
	assert.deepEqual(await readFile(file), bytes);

	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved = await loadWorkspace(file);
	assert.equal(saved.duplicateDecisions.size, 1);
	assert.equal(saved.matchDecisions.has(secondId), false);
	assert.equal(saved.reviewApprovals.get(secondId)?.approval?.documentId, secondDocument);
	assert.equal(saved.reviewApprovals.get(secondId)?.associationRevision, 2);
	await session.dispatch({ type: 'open' });
	assert.equal(summaries().has(secondId), false);
	assert.equal((await decide('clear', secondId, firstId)).error, null);
	assert.deepEqual(summaries().get(secondId)?.review, { status: 'assigned', documentId: secondDocument });
	assert.equal(summaries().get(secondId)?.approvalStatus.status, 'revoked');
	assert.equal(summaries().get(firstId)?.approvalStatus.status, 'approved');
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal((await loadWorkspace(file)).duplicateDecisions.size, 0);
});

test('rejects stale and conflicting duplicate decisions and preserves explicitly separated bookings', async (context) => {
	const { file, banks, firstId, secondId, thirdId, session, decide, summaries } = await fixture(context);
	await createWorkspace(file, newMetadata(), banks);
	await session.dispatch({ type: 'open' });
	const revision = session.state().workspace!.matchRevision;
	assert.equal((await decide('separate')).error, null);
	assert.match((await decide('keep-first', thirdId, firstId, revision)).error ?? '', /changed/);
	assert.equal((await decide('keep-first', thirdId, firstId)).error, null);
	const conflict = await decide('keep-first', thirdId, secondId);
	assert.match(conflict.error ?? '', /kept separate/);
	assert.equal(conflict.workspace?.duplicateDecisions.length, 2);
	assert.equal(summaries().has(secondId), true);
	assert.equal(summaries().has(firstId), false);
	assert.match((await decide('keep-first', secondId, thirdId)).error ?? '', /leading booking cannot also be excluded/);
	assert.match((await decide('keep-first', thirdId, randomUUID())).error ?? '', /no longer possible duplicates/);
});

test('requires resolving a reassigned document before restoring its archived review', async (context) => {
	const { root, file, banks, firstId, secondId, receipts, session, decide, summaries } = await fixture(context);
	const [receipt] = receipts;
	await createWorkspace(file, newMetadata(), banks, [documentRun(root, [receipt])], new Map([[secondId, receipt.id]]));
	await session.dispatch({ type: 'open' });
	assert.equal((await decide('keep-first')).error, null);
	const assign = await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision,
		transactionId: firstId, review: { status: 'assigned', documentId: receipt.id } });
	assert.equal(assign.error, null);
	const blocked = await decide('clear');
	assert.match(blocked.error ?? '', /archived document is now assigned/);
	assert.equal(blocked.workspace?.duplicateDecisions.length, 1);
	assert.equal(summaries().has(secondId), false);
	await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision, transactionId: firstId, review: { status: 'open' } });
	assert.equal((await decide('clear')).error, null);
	assert.deepEqual(summaries().get(secondId)?.review, { status: 'assigned', documentId: receipt.id });
});

test('rejects excluding multiple bookings from one statement against a single leading booking', async (context) => {
	const { file, banks, firstId, secondId, session, decide, summaries } = await fixture(context);
	const additionalId = randomUUID(), additionalRow = { ...banks[0].result.transactions[0], rowId: 'additional-booking' };
	banks[0].transactions.push({ rowId: additionalRow.rowId, transactionId: additionalId });
	banks[0].result.transactions.push(additionalRow);
	await createWorkspace(file, newMetadata(), banks);
	await session.dispatch({ type: 'open' });
	assert.equal((await decide('keep-first', secondId, firstId)).error, null);
	const rejected = await decide('keep-first', secondId, additionalId);
	assert.match(rejected.error ?? '', /one booking per statement/);
	assert.equal(rejected.workspace?.duplicateDecisions.length, 1);
	assert.equal(summaries().has(additionalId), true);
});

test.for(['account', 'reference'])('rejects bridging conflicting known %s identities through a leading booking with missing evidence', async (field, context) => {
	const { file, banks, firstId, secondId, thirdId, session, decide, summaries } = await fixture(context);
	for (const [index, bank] of banks.entries()) {
		const account = bank.result.accountSections[0], row = bank.result.transactions[0];
		account.accountReference = field === 'account' && index !== 0 ? { label: 'Account identifier', value: `ACCOUNT-${index}`, evidence: account.evidence } : null;
		row.references = field === 'reference' && index !== 0 ? [{ label: 'Transaction ID', value: `TRANSACTION-${index}`, evidence: row.evidence }] : [];
	}
	await createWorkspace(file, newMetadata(), banks);
	await session.dispatch({ type: 'open' });
	assert.equal((await decide('keep-first', firstId, secondId)).error, null);
	const rejected = await decide('keep-first', firstId, thirdId);
	assert.match(rejected.error ?? '', /conflicting bank, account or transaction identifiers/);
	assert.equal(rejected.workspace?.duplicateDecisions.length, 1);
	assert.equal(summaries().has(thirdId), true);
});

test('opens a version 8 workspace without writing and migrates it on explicit save', async (context) => {
	const { file, banks, session, decide, secondId, summaries } = await fixture(context);
	await createWorkspace(file, newMetadata(), banks);
	const db = new Database(file);
	try { db.exec('DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; PRAGMA user_version=8;'); }
	finally { db.close(); }
	const before = await readFile(file);
	assert.equal((await session.dispatch({ type: 'open' })).workspace?.dirty, false);
	assert.equal((await decide('keep-first')).error, null);
	assert.deepEqual(await readFile(file), before);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.equal(saved.duplicateDecisions.size, 1);
	assert.equal(summaries().has(secondId), false);
});
