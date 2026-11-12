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
import { applyDocumentCorrections, documentCorrectionKey, type DocumentCorrection, type DocumentCorrectionValue } from '../../src/shared/document-corrections.js';
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

test.for(['counterparty', 'booking description'])('ranks an existing uncertain match by filename and %s when reopening a workspace', async (source, context) => {
	const root = await directory(context);
	const file = path.join(root, 'filename.receiptmatch');
	const bank = retainedBank(root);
	const booking = bank.result.transactions[0];
	booking.description.value = 'Card payment Orchard Workshop 1234';
	booking.counterpartyCandidate = source === 'counterparty' ? { value: 'Orchard Workshop', evidence: booking.description.evidence } : null;
	const receipt = (filename: string, total = '1,234.56') => document(root, filename, 'Receipt', `Total: EUR ${total}`);
	const generic = receipt('IMG_1234.pdf');
	const substring = receipt('Orchard Workshops.pdf');
	const named = receipt('2032-02-28_Órchard-Workshop_lunch.pdf');
	const wrongAmount = receipt('Orchard Workshop.pdf', '1,234.57');
	generic.id = '00000000-0000-4000-8000-000000000001';
	substring.id = '00000000-0000-4000-8000-000000000002';
	assert.equal(named.result.sections[0].merchants.length, 0);
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [generic, substring, named, wrongAmount])]);
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	await session.dispatch({ type: 'open' });
	const { transactionId } = bank.transactions[0];
	const savedMatch = session.matchResults().find(match => match.transactionId === transactionId)!;
	assert.equal(savedMatch.status, 'uncertain');
	assert.equal(savedMatch.candidates[0].documentId, generic.id);
	const revision = session.state().workspace!.matchRevision;
	const details = session.matchDetails(revision, transactionId)!;
	assert.deepEqual(details.candidates.map(candidate => candidate.documentId), [named.id, substring.id, wrongAmount.id, generic.id]);
	const bankText = booking.counterpartyCandidate?.value ?? booking.description.value;
	assert.deepEqual(details.candidates.map(candidate => candidate.signals.filename.state), ['match', 'partial', 'match', 'missing']);
	assert.equal(details.candidates[0].signals.filename.bankText, bankText);
	assert.equal(details.candidates[2].signals.amount, 'close');
	assert.equal(session.state().workspace?.dirty, false);
});

test('combines independent signals for existing workspaces with no exact amount match', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'signals.receiptmatch');
	const bank = retainedBank(root);
	const booking = bank.result.transactions[0];
	booking.description.value = 'Vela Restaurant New';
	booking.counterpartyCandidate = null;
	booking.reportedOriginalAmount = null;
	booking.accountAmount.value = { coefficient: '-17677', scale: 2, currency: 'EUR' };
	const named = document(root, 'Vela-Backyard.pdf', 'Vela Backyard', 'Total: EUR 160.70');
	const reference = document(root, 'other-merchant.pdf', 'Invoice', 'Merchant: Other Merchant', 'Invoice Number: SYNTHETIC-A', 'Invoice Total: USD 48.00');
	const dated = document(root, 'Vela.pdf', 'Receipt', 'Merchant: Vela', 'Issue Date: 2032-02-27', 'Receipt Number: UNRELATED');
	const near = document(root, 'Different-Shop.pdf', 'Receipt', 'Issue Date: 2032-02-28', 'Total: EUR 167.00');
	const generic = document(root, 'IMG_1234.pdf', 'Receipt', 'Total: EUR 160.70');
	const large = document(root, 'Vela Large.pdf', 'Receipt', 'Total: EUR 80.00');
	assert.equal(named.result.sections[0].kind, 'unknown');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [named, reference, dated, near, generic, large])]);
	const savedBytes = await readFile(file);
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	await session.dispatch({ type: 'open' });
	const { transactionId } = bank.transactions[0];
	const revision = session.state().workspace!.matchRevision;
	assert.equal(session.matchResults().find(match => match.transactionId === transactionId)?.status, 'unmatched');
	assert.equal(session.matchSummaries(revision)?.find(row => row.transactionId === transactionId)?.status, 'uncertain');
	const candidates = new Map(session.matchDetails(revision, transactionId)?.candidates.map(candidate => [candidate.documentId, candidate]));
	assert.equal(candidates.size, 4);
	assert.equal(candidates.get(named.id)?.signals.amount, 'close');
	assert.equal(candidates.get(named.id)?.signals.filename.state, 'partial');
	assert.equal(candidates.get(reference.id)?.signals.reference, 'match');
	assert.equal(candidates.get(reference.id)?.signals.merchant.state, 'different');
	assert.equal(candidates.get(reference.id)?.signals.amount, 'currency-differs');
	assert.equal(candidates.get(dated.id)?.signals.amount, 'missing');
	assert.equal(candidates.get(dated.id)?.date?.daysApart, 1);
	assert.equal(candidates.get(near.id)?.signals.filename.state, 'different');
	assert.equal(session.state().workspace?.dirty, false);
	assert.deepEqual(await readFile(file), savedBytes);
});

test('recovers a split OCR date in match suggestions for an already imported receipt', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'split-date.receiptmatch');
	const bank = retainedBank(root);
	const booking = bank.result.transactions[0];
	booking.description.value = 'Orchard Workshop Ltd 1';
	booking.counterpartyCandidate = null;
	const receipt = document(root, 'Orchard-Workshop.pdf', 'Orchard Workshop', '27/02/2032 Original');
	const page = receipt.result.input!.pages[0];
	page.spans[1].method = 'local-ocr';
	const date = receipt.result.sections[0].dates[0];
	date.evidence[0].method = 'local-ocr';
	page.spans.push({ text: 'Date', region: { x: 4, y: 59.5, width: 20, height: 10.5 }, method: 'local-ocr' });
	assert.equal(date.role, 'unknown');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt])]);
	const savedBytes = await readFile(file);
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	await session.dispatch({ type: 'open' });
	const { transactionId } = bank.transactions[0];
	const revision = session.state().workspace!.matchRevision;
	assert.equal(session.matchSummaries(revision)?.find(row => row.transactionId === transactionId)?.status, 'uncertain');
	const candidate = session.matchDetails(revision, transactionId)?.candidates[0];
	assert.equal(candidate?.documentId, receipt.id);
	assert.equal(candidate?.date?.documentDate, '2032-02-27');
	assert.equal(candidate?.date?.daysApart, 1);
	assert.ok(candidate?.documentEvidence.some(item => item.text === 'Date'));
	assert.deepEqual(await readFile(file), savedBytes);
});

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
	try {
		db.exec(`DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections;
			DROP TABLE match_reviews; DROP TABLE match_results; PRAGMA user_version=3;`);
	} finally { db.close(); }
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
	try { db.exec('DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews; PRAGMA user_version=4;'); }
	finally { db.close(); }
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
	try { db.exec('DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; PRAGMA user_version=5;'); } finally { db.close(); }
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
	assert.equal(summary(first.transactionId)?.status, 'uncertain');
	const referenceOnly = session.matchDetails(state().matchRevision, first.transactionId)?.candidates[0];
	assert.equal(referenceOnly?.signals.reference, 'match');
	assert.equal(referenceOnly?.signals.amount, 'different');
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

test('recalculates matches from corrected document fields and saves originals, revisions and review decisions atomically', async (context) => {
	const root = await directory(context);
	const file = path.join(root, 'document-corrections.receiptmatch');
	const bank = retainedBank(root);
	const transactionId = bank.transactions[0].transactionId;
	const receipt = document(root, 'original.pdf', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-31', 'Invoice Total: EUR 98.00');
	const missing = document(root, 'missing.pdf', 'Receipt', 'Merchant: River Studio');
	const source = documentRun(root, [receipt, missing]);
	await createWorkspace(file, newMetadata(), [bank], [source]);
	const db = new Database(file);
	try { db.exec('DROP TABLE match_approval_state; DROP TABLE document_corrections; PRAGMA user_version=6;'); } finally { db.close(); }
	const before = await readFile(file);
	const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	assert.equal((await loadWorkspace(file)).schemaVersion, 6);
	assert.deepEqual(await readFile(file), before);
	const state = () => session.state().workspace!;
	const { sectionId, amounts, dates } = receipt.result.sections[0];
	assert.deepEqual(dates[0].candidates, []);
	const revision = state().matchRevision;
	const correct = (fieldId: string | null, change: DocumentCorrectionValue, at = state().matchRevision) =>
		session.dispatch(commandSchema.parse({ type: 'correct-document-field', revision: at, documentId: receipt.id, sectionId, fieldId, change }));
	assert.equal(session.matchResults().find(match => match.transactionId === transactionId)?.status, 'unmatched');
	assert.equal((await correct(amounts[0].id, { kind: 'amount', value: { coefficient: '123456', scale: 2, currency: 'EUR' } })).error, null);
	assert.match((await correct(dates[0].id, { kind: 'date', value: '2032-02-28' }, revision)).error!, /Refresh/);
	assert.match((await correct(amounts[0].id, { kind: 'date', value: '2032-02-28' })).error!, /field.*not available/);
	assert.equal((await correct(dates[0].id, { kind: 'date', value: '2032-02-28' })).error, null);
	const dateRevision = state().matchRevision;
	await correct(amounts[0].id, { kind: 'amount', value: { coefficient: '1234560', scale: 3, currency: 'EUR' } });
	assert.equal(state().matchRevision, dateRevision);
	const candidate = session.matchDetails(dateRevision, transactionId)?.candidates[0];
	assert.equal(candidate?.documentValuesCorrected, true);
	assert.equal(candidate?.date?.documentDate, '2032-02-28');
	assert.ok(candidate?.documentEvidence.some(item => item.text.includes('EUR 98.00')));
	assert.equal(session.matchResults().find(match => match.transactionId === transactionId)?.status, 'reliable');
	const added = await session.dispatch({ type: 'correct-document-field', revision: dateRevision, documentId: missing.id, sectionId: missing.result.sections[0].sectionId,
		fieldId: null, change: { kind: 'amount', value: { coefficient: '900719925474099327', scale: 2, currency: 'EUR' } } });
	assert.equal(added.error, null);
	const overlays = new Map(state().documentCorrections.map(item => [documentCorrectionKey(item, item.change.kind), item]));
	const supplied = applyDocumentCorrections([source], overlays)[0].files[1];
	assert.equal(supplied.status, 'imported');
	if (supplied.status !== 'imported') throw new Error('Expected imported receipt');
	const suppliedField = supplied.record.result.sections[0].amounts[0];
	assert.match((await session.dispatch({ type: 'correct-document-field', revision: state().matchRevision, documentId: missing.id,
		sectionId: missing.result.sections[0].sectionId, fieldId: suppliedField.id, change: { kind: 'amount', value: { coefficient: '1234', scale: 2, currency: 'EUR' } }
	})).error!, /field.*not available/);
	assert.deepEqual(session.documentImports(), [source]);
	assert.equal((await session.dispatch({ type: 'review-match', revision: state().matchRevision, transactionId,
		review: { status: 'assigned', documentId: receipt.id } })).error, null);
	const originalPrepare = Database.prototype.prepare;
	const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
		if (sql.startsWith('INSERT INTO match_results')) throw new Error('Controlled match write failure');
		return originalPrepare.call(this, sql);
	});
	try { assert.match((await session.dispatch({ type: 'save' })).error!, /Controlled match write failure/); }
	finally { prepare.mockRestore(); }
	assert.deepEqual(await readFile(file), before);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	const saved = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(saved.documentImports, [source]);
	assert.deepEqual(saved.matchDecisions.get(transactionId), receipt.id);
	assert.deepEqual([...saved.documentCorrections.values()].map(item => item.revision).sort(), [2, 2, 3]);
	const effective = applyDocumentCorrections(saved.documentImports, saved.documentCorrections)[0].files[1];
	assert.equal(effective.status, 'imported');
	if (effective.status !== 'imported') throw new Error('Expected imported receipt');
	assert.deepEqual(effective.record.result.sections[0].amounts[0].evidence, []);
	assert.equal(effective.record.result.sections[0].amounts[0].candidates[0].coefficient, '900719925474099327');
	assert.ok(effective.record.result.issues.some(issue => issue.field === 'issue'));
	const check = new Database(file, { readonly: true });
	try { assert.deepEqual(check.prepare('SELECT revision FROM documents WHERE id=?').get(receipt.id), { revision: 3 }); }
	finally { check.close(); }
});

test('keeps both fields in review when a correction makes agreeing document totals conflict', async (context) => {
	const root = await directory(context);
	const original = invoice(root, 'duplicate-total.pdf');
	const section = original.result.sections[0];
	const first = section.amounts[0];
	const second = { ...first, id: 'duplicate-total' };
	section.amounts.push(second);
	const sources = [documentRun(root, [original])];
	const firstCorrection: DocumentCorrection = { documentId: original.id, sectionId: section.sectionId, fieldId: first.id, revision: 2,
		change: { kind: 'amount', value: { coefficient: '123457', scale: 2, currency: 'EUR' } } };
	const corrections = new Map([[documentCorrectionKey(firstCorrection, 'amount'), firstCorrection]]);
	const corrected = () => applyDocumentCorrections(sources, corrections)[0].files[0];
	let file = corrected();
	assert.equal(file.status, 'imported');
	assert.deepEqual(file.record.result.issues.filter(issue => issue.code === 'conflicting-field').map(issue => issue.fieldId), [first.id, second.id]);
	const secondCorrection = { ...firstCorrection, fieldId: second.id, revision: 3 };
	corrections.set(documentCorrectionKey(secondCorrection, 'amount'), secondCorrection);
	file = corrected();
	assert.equal(file.status, 'imported');
	assert.equal(file.record.result.issues.some(issue => issue.code === 'conflicting-field'), false);
	assert.equal(original.result.issues.some(issue => issue.code === 'conflicting-field'), false);
});
