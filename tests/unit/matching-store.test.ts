import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, vi, type TestContext } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { commandSchema } from '../../src/shared/protocol.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { MatchReview } from '../../src/shared/workspace-matching.js';
import { row as bankRow, statement } from './bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank } from './document-fixtures.js';

async function directory(context: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-suggestions-'));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}

function document(root: string, filename: string, ...lines: string[]): StoredSupportingDocument {
	const { input } = extractedDocument(Buffer.from(filename), randomUUID());
	input.pages[0].spans = lines.map((text, index) => ({ text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text' }));
	return { id: randomUUID(), importedAt: '2032-05-20T12:00:00Z', filePath: path.join(root, filename), format: 'pdf', result: interpretSupportingDocument(input) };
}

function invoice(root: string, filename: string) {
	return document(root, filename, 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1,234.56');
}

test('recomputes the workspace snapshot on each successful import and saves it only on explicit Save', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'matches.receiptmatch');
	const bank = retainedBank(root);
	let nextDocument: StoredDocumentImport | null = documentRun(root, [invoice(root, 'first.pdf')]);
	const session = new WorkspaceSession(
		{ open: async () => file, save: async () => file, unsaved: async () => 'discard' },
		undefined,
		{ run: async () => ({ status: 'imported', record: bank }) },
		{ run: async () => nextDocument },
	);
	await session.dispatch({ type: 'new' });
	await session.dispatch({ type: 'import-statement' });
	assert.deepEqual(session.matchResults().map((match) => match.status), ['unmatched', 'unmatched']);
	await session.dispatch({ type: 'import-documents' });
	const first = session.matchResults();
	const transactionId = bank.transactions[0].transactionId;
	const firstRevision = session.state().workspace!.matchRevision;
	assert.equal(first.find((match) => match.transactionId === transactionId)?.status, 'reliable');
	assert.equal(session.matchSummaries(firstRevision)?.find((row) => row.transactionId === transactionId)?.candidateCount, 1);
	const projected = session.matchDetails(firstRevision, transactionId);
	assert.equal(projected?.candidates[0].documentEvidence.some((item) => item.page === 1 && item.text.includes('SYNTHETIC-A')), true);
	await session.dispatch({ type: 'save' });
	assert.deepEqual((await loadWorkspace(file)).matches, first);
	const savedBytes = await readFile(file);

	nextDocument = documentRun(root, [invoice(root, 'second.pdf')]);
	nextDocument.status = 'cancelled';
	await session.dispatch({ type: 'import-documents' });
	const competing = session.matchResults();
	assert.equal(competing.find((match) => match.transactionId === transactionId)?.status, 'uncertain');
	assert.equal(competing.find((match) => match.transactionId === transactionId)?.candidates.length, 2);
	assert.equal(session.matchSummaries(firstRevision), null);
	assert.equal(session.matchDetails(firstRevision, transactionId), null);
	assert.deepEqual(await readFile(file), savedBytes);
	await session.dispatch({ type: 'save' });
	await session.dispatch({ type: 'new' });
	assert.deepEqual(session.matchResults(), []);
	await session.dispatch({ type: 'open' });
	assert.deepEqual(session.matchResults(), competing);
	assert.equal(session.state().workspace?.dirty, false);
	const db = new Database(file, { readonly: true });
	try {
		const rows = db.prepare('SELECT record_json FROM match_results ORDER BY transaction_id').all() as { record_json: string }[];
		assert.deepEqual(rows.map((row) => JSON.parse(row.record_json) as unknown), competing);
		assert.deepEqual(db.prepare('SELECT * FROM associations').all(), []);
	} finally { db.close(); }
});

test('opens version 3 without writing, suppresses coalesced legacy sections and upgrades on explicit Save', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'legacy.receiptmatch');
	const bank = retainedBank(root);
	const legacyOnOnePage = document(root, 'legacy.pdf', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Total: EUR 1,234.56', 'Invoice',
		'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28');
	const legacyAcrossPages = document(root, 'legacy-paged.pdf', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Total: EUR 1,234.56');
	const secondPage = document(root, 'second-page.pdf', 'Merchant: Cedar Workshop', 'Invoice', 'Merchant: Cedar Workshop',
		'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28').result.input!.pages[0];
	legacyAcrossPages.result.input!.pages.push({ ...secondPage, pageId: 'page-2', pageNumber: 2 });
	legacyAcrossPages.result = interpretSupportingDocument(legacyAcrossPages.result.input);
	for (const legacy of [legacyOnOnePage, legacyAcrossPages]) {
		const [first, second] = legacy.result.sections;
		legacy.result.parserVersion = '1';
		legacy.result.sections = [{ ...first, pageIds: [...new Set([...first.pageIds, ...second.pageIds])],
			dates: second.dates, references: second.references, merchants: [...first.merchants, ...second.merchants] }];
		legacy.result.status = 'complete';
		legacy.result.issues = [];
	}
	const valid = invoice(root, 'valid.pdf');
	const oldRun = documentRun(root, [legacyOnOnePage, legacyAcrossPages, valid]);
	await createWorkspace(file, newMetadata(), [bank], [oldRun]);
	const db = new Database(file);
	try { db.exec('DROP TABLE bank_corrections; DROP TABLE match_reviews; DROP TABLE match_results; PRAGMA user_version=3;'); } finally { db.close(); }
	const oldBytes = await readFile(file);
	const opened = await loadWorkspace(file);
	assert.equal(opened.schemaVersion, 3);
	assert.deepEqual(await readFile(file), oldBytes);
	assert.deepEqual(opened.documentImports, [oldRun]);
	const match = opened.matches.find((match) => match.transactionId === bank.transactions[0].transactionId);
	assert.equal(match?.status, 'reliable');
	assert.deepEqual(match.candidates.map((candidate) => candidate.documentId), [valid.id]);
	const originalPrepare = Database.prototype.prepare;
	const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
		if (sql.startsWith('INSERT INTO match_results')) throw new Error('Controlled migration write failure');
		return originalPrepare.call(this, sql);
	});
	try { await assert.rejects(() => saveWorkspace(opened, opened.metadata), /Controlled migration write failure/); }
	finally { prepare.mockRestore(); }
	assert.deepEqual(await readFile(file), oldBytes);
	assert.equal((await loadWorkspace(file)).schemaVersion, 3);
	const saved = await saveWorkspace(opened, opened.metadata);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual((await loadWorkspace(file)).matches, opened.matches);
	assert.deepEqual(saved.documentImports, [oldRun]);
});

test('loads persisted evidence without requiring the current engine to produce the same judgment', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'stored-judgment.receiptmatch');
	const bank = retainedBank(root);
	const saved = await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [invoice(root, 'invoice.pdf')])]);
	const historical = saved.matches.find((match) => match.status === 'reliable')!;
	historical.status = 'uncertain';
	historical.candidates[0].issues = ['conflicting-evidence'];
	const db = new Database(file);
	try { db.prepare('UPDATE match_results SET record_json=? WHERE transaction_id=?').run(JSON.stringify(historical), historical.transactionId); }
	finally { db.close(); }
	const loaded = await loadWorkspace(file);
	assert.deepEqual(loaded.matches, saved.matches);
	const newDocumentImports = [...loaded.documentImports, documentRun(root, [])];
	assert.deepEqual((await saveWorkspace(loaded, loaded.metadata, loaded.imports, newDocumentImports)).matches, saved.matches);
});

test('rolls back a match write failure together with the appended import and rejects corrupt saved results', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'atomic.receiptmatch');
	const bank = retainedBank(root);
	const saved = await createWorkspace(file, newMetadata(), [bank]);
	const before = await readFile(file);
	const originalPrepare = Database.prototype.prepare;
	const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
		if (sql.startsWith('INSERT INTO match_results')) throw new Error('Controlled match write failure');
		return originalPrepare.call(this, sql);
	});
	try {
		await assert.rejects(() => saveWorkspace(saved, saved.metadata, [bank], [documentRun(root, [invoice(root, 'new.pdf')])]), /Controlled match write failure/);
	} finally { prepare.mockRestore(); }
	assert.deepEqual(await readFile(file), before);
	assert.deepEqual((await loadWorkspace(file)).matches, saved.matches);
	const db = new Database(file);
	try { db.exec("UPDATE match_results SET record_json='{}'"); } finally { db.close(); }
	const corrupted = await readFile(file);
	await assert.rejects(() => loadWorkspace(file), /suggestions do not agree/);
	assert.deepEqual(await readFile(file), corrupted);
});

test('reviews transactions independently of confidence and keeps exclusive decisions and counts after reopening', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'review.receiptmatch');
	const bank = retainedBank(root);
	const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
	const suggested = invoice(root, 'invoice.pdf');
	const other = document(root, 'restaurant.pdf', 'Receipt', 'Total: EUR 142.00');
	const imports = documentRun(root, [suggested, other]);
	const session = new WorkspaceSession(
		{ open: async () => file, save: async () => file, unsaved: async () => 'discard' },
		undefined,
		{ run: async () => ({ status: 'imported', record: bank }) },
		{ run: async () => imports },
	);
	const revision = () => session.state().workspace!.matchRevision;
	const review = (transactionId: string, decision: MatchReview, at = revision()) =>
		session.dispatch(commandSchema.parse({ type: 'review-match', revision: at, transactionId, review: decision }));
	const row = (transactionId: string) => session.matchSummaries(revision())?.find(item => item.transactionId === transactionId);
	const counts = () => session.state().workspace!.matchReviewCounts;
	await session.dispatch({ type: 'new' });
	await session.dispatch({ type: 'import-statement' });
	await session.dispatch({ type: 'import-documents' });
	const suggestions = session.matchResults();
	assert.equal(row(first)?.status, 'reliable');
	assert.deepEqual(counts(), { open: 2, assigned: 0, 'completed-without-document': 0 });
	assert.equal(row(first)?.review.status, 'open');
	const initialRevision = revision();
	assert.equal(commandSchema.safeParse({ type: 'review-match', revision: initialRevision, transactionId: first,
		review: { status: 'assigned', documentId: other.id, filePath: other.filePath } }).success, false);
	assert.match((await review(first, { status: 'assigned', documentId: randomUUID() })).error!, /not available/);
	assert.match((await review(randomUUID(), { status: 'open' })).error!, /no longer available/);
	assert.equal((await review(first, { status: 'assigned', documentId: other.id })).error, null);
	assert.match((await review(first, { status: 'open' }, initialRevision)).error!, /Refresh/);
	assert.match((await review(second, { status: 'assigned', documentId: other.id })).error!, /already assigned/);
	assert.deepEqual(row(first)?.review, { status: 'assigned', documentId: other.id });
	assert.equal(row(second)?.review.status, 'open');
	assert.deepEqual(session.matchResults(), suggestions);
	await review(first, { status: 'assigned', documentId: suggested.id });
	await review(second, { status: 'assigned', documentId: other.id });
	await review(second, { status: 'open' });
	assert.equal(row(second)?.review.status, 'open');
	await review(second, { status: 'completed-without-document' });
	assert.deepEqual(counts(), { open: 0, assigned: 1, 'completed-without-document': 1 });
	await session.dispatch({ type: 'save' });
	assert.equal(session.state().workspace?.dirty, false);
	const savedRevision = revision();
	await review(second, { status: 'completed-without-document' });
	assert.equal(revision(), savedRevision);
	assert.equal(session.state().workspace?.dirty, false);
	await review(first, { status: 'open' });
	assert.equal(session.state().workspace?.dirty, true);
	assert.equal((await loadWorkspace(file)).matchDecisions.get(first), suggested.id);
	await session.dispatch({ type: 'open' });
	assert.deepEqual(row(first)?.review, { status: 'assigned', documentId: suggested.id });
	assert.equal(row(second)?.review.status, 'completed-without-document');
	assert.deepEqual(counts(), { open: 0, assigned: 1, 'completed-without-document': 1 });
	await review(first, { status: 'open' });
	assert.equal((await review(second, { status: 'assigned', documentId: suggested.id })).error, null);
	await session.dispatch({ type: 'save' });
	await session.dispatch({ type: 'open' });
	assert.equal(row(first)?.review.status, 'open');
	assert.deepEqual(row(second)?.review, { status: 'assigned', documentId: suggested.id });
	assert.deepEqual(counts(), { open: 1, assigned: 1, 'completed-without-document': 0 });
});

test('opens version 4 without writing and saves review decisions and migration atomically', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'v4-review.receiptmatch');
	const bank = retainedBank(root);
	const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
	const document = invoice(root, 'invoice.pdf');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [document])]);
	const db = new Database(file);
	try { db.exec('DROP TABLE bank_corrections; DROP TABLE match_reviews; PRAGMA user_version=4;'); } finally { db.close(); }
	const bytes = await readFile(file);
	const opened = await loadWorkspace(file);
	assert.equal(opened.schemaVersion, 4);
	assert.equal(opened.matchDecisions.size, 0);
	assert.deepEqual(await readFile(file), bytes);
	const save = (decisions: Map<string, string | null>) => saveWorkspace(opened, opened.metadata, opened.imports, opened.documentImports, decisions);
	await assert.rejects(() => save(new Map([[first, document.id], [second, document.id]])), /already assigned/);
	const decisions = new Map([[first, document.id], [second, null]]);
	const originalPrepare = Database.prototype.prepare;
	const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
		if (sql.startsWith('INSERT INTO match_reviews')) throw new Error('Controlled review write failure');
		return originalPrepare.call(this, sql);
	});
	try { await assert.rejects(() => save(decisions), /Controlled review write failure/); }
	finally { prepare.mockRestore(); }
	assert.deepEqual(await readFile(file), bytes);
	await save(decisions);
	const migrated = await loadWorkspace(file);
	assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(migrated.matchDecisions, decisions);
	assert.deepEqual(migrated.matches, opened.matches);
});

test('corrects booking values with exact money, retains original evidence and promotes only resolved drafts', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'booking-corrections.receiptmatch');
	const input = statement();
	input.pages[0].spans.push(...bankRow(335, '26 Feb 2032', 'To: Cedar Tools', null, null), ...bankRow(385, '25 Feb 2032', '', null, null).filter(span => span.text));
	const bank = retainedBank(root, input);
	const bankBefore = structuredClone(bank);
	const [first] = bank.transactions;
	const [draft, blocked] = bank.drafts;
	assert.ok(first && draft && blocked);
	const documents = documentRun(root, [invoice(root, 'invoice.pdf')]);
	const created = await createWorkspace(file, newMetadata(), [bank], [documents]);
	const db = new Database(file);
	try { db.exec('DROP TABLE bank_corrections; PRAGMA user_version=5;'); } finally { db.close(); }
	const before = await readFile(file);
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	await session.dispatch({ type: 'open' });
	const state = () => session.state().workspace!;
	const correct = (rowId: string, changes: { bookingDate?: string; accountAmount?: { currency: string; coefficient: string; scale: number } }, revision = state().matchRevision) =>
		session.dispatch(commandSchema.parse({ type: 'correct-bank-row', rowId, revision, changes }));
	const summary = (id: string) => session.matchSummaries(state().matchRevision)?.find(row => row.transactionId === id);
	assert.equal((await loadWorkspace(file)).schemaVersion, 5);
	assert.deepEqual(await readFile(file), before);
	assert.equal(summary(first.transactionId)?.status, 'reliable');
	const originalDate = summary(first.transactionId)!.bookingDate;
	const revision = state().matchRevision;
	await correct(first.transactionId, { bookingDate: originalDate });
	assert.equal(state().matchRevision, revision);
	assert.equal(state().dirty, false);
	assert.match((await correct(first.transactionId, { accountAmount: { currency: 'USD', coefficient: '-25620', scale: 2 } })).error!, /account currency/);
	assert.equal((await correct(first.transactionId, { bookingDate: '2032-04-30' })).error, null);
	assert.equal(summary(first.transactionId)?.bookingDate, '2032-04-30');
	assert.equal(summary(first.transactionId)?.bankValuesCorrected, true);
	const changedDate = session.matchDetails(state().matchRevision, first.transactionId)?.candidates[0].date;
	assert.equal(changedDate?.bookingDate, '2032-04-30');
	assert.equal(changedDate?.withinWindow, false);
	assert.match((await correct(first.transactionId, { bookingDate: originalDate }, revision)).error!, /Refresh/);
	assert.equal((await correct(first.transactionId, { accountAmount: { currency: 'EUR', coefficient: '-25620', scale: 2 } })).error, null);
	assert.equal(summary(first.transactionId)?.status, 'unmatched');
	const correctedRevision = state().matchRevision;
	await correct(first.transactionId, { accountAmount: { currency: 'EUR', coefficient: '-256200', scale: 3 } });
	assert.equal(state().matchRevision, correctedRevision);
	const exact = { currency: 'EUR', coefficient: '-900719925474099327', scale: 2 };
	assert.equal((await correct(draft.draftId, { accountAmount: exact })).error, null);
	assert.deepEqual(summary(draft.draftId)?.accountAmount, exact);
	assert.equal(state().imports[0].transactions, 3);
	assert.equal((await correct(blocked.draftId, { accountAmount: exact })).error, null);
	assert.equal(summary(blocked.draftId), undefined);
	assert.equal(state().imports[0].drafts, 1);
	assert.deepEqual(session.bankImports(), [bankBefore]);
	assert.deepEqual(await readFile(file), before);
	const review = await session.dispatch({ type: 'review-match', transactionId: draft.draftId, revision: state().matchRevision, review: { status: 'completed-without-document' } });
	assert.equal(review.error, null);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	const saved = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.equal(saved.bankCorrections.get(first.transactionId)?.revision, 3);
	assert.deepEqual(saved.imports, created.imports);
	assert.deepEqual(summary(draft.draftId)?.review, { status: 'completed-without-document' });
	assert.deepEqual(summary(draft.draftId)?.accountAmount, exact);
	assert.equal(state().dirty, false);
	const check = new Database(file, { readonly: true });
	try {
		assert.deepEqual(check.prepare('SELECT coefficient, revision FROM transactions WHERE id=?').get(draft.draftId), { coefficient: exact.coefficient, revision: 2 });
	} finally { check.close(); }
});
