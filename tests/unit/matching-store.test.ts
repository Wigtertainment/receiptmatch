import type { BankImportInput, ImportIssue, ImportPage, PositionedSpan, SourceEvidence, TransactionCandidate } from "../../src/shared/bank-import.js";
import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { MatchCandidate, TransactionMatch } from "../../src/shared/workspace-matching.js";
import type { DocumentIssue, DocumentSection, SupportingDocument } from "../../src/shared/supporting-document.js";
import type { MatchApprovalSelection } from "../../src/shared/match-approvals.js";
import type { MatchReviewCounts } from "../../src/shared/workspace-matching.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import type { WorkspaceView } from "../../src/shared/protocol.js";
import type { MatchSourceExcerpt } from "../../src/shared/workspace-matching.js";
import type { MatchSummary } from "../../src/shared/workspace-matching.js";
import type { MatchCandidateView } from "../../src/shared/workspace-matching.js";
import type { MatchDetails } from "../../src/shared/workspace-matching.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, vi, type TestContext } from 'vitest';
import { SupportingDocumentState } from '../../electron/documents/document-state.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import { reconciliationRows } from '../../electron/reconciliation-csv.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { commandSchema } from '../../src/shared/protocol.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { MatchReview } from '../../src/shared/workspace-matching.js';
import { applyDocumentCorrections, documentCorrectionKey, type DocumentCorrection, type DocumentCorrectionValue } from '../../src/shared/document-corrections.js';
import { row as bankRow, statement } from './bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank } from './document-fixtures.js';

async function directory(context: TestContext): Promise<string> {
	const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-suggestions-'));
	context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
	return root;
}

function document(root: string, filename: string, ...lines: string[]): StoredSupportingDocument {
	const { input }: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(Buffer.from(filename), randomUUID());
	input.pages[0].spans = lines.map((text: string, index: number): { text: string; region: { x: number; y: number; width: number; height: number; }; method: "embedded-text"; } => ({ text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text' }));
	return { id: randomUUID(), importedAt: '2032-05-20T12:00:00Z', filePath: path.join(root, filename), format: 'pdf', result: interpretSupportingDocument(input) };
}

function invoice(root: string, filename: string): StoredSupportingDocument {
	return document(root, filename, 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1,234.56');
}

test.for(['counterparty', 'booking description'])('ranks an existing uncertain match by filename and %s when reopening a workspace', async (source: string, context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'filename.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const booking: TransactionCandidate = bank.result.transactions[0];
	booking.description.value = 'Card payment Orchard Workshop 1234';
	booking.counterpartyCandidate = source === 'counterparty' ? { value: 'Orchard Workshop', evidence: booking.description.evidence } : null;
	const receipt: (filename: string, total?: string) => StoredSupportingDocument = (filename: string, total: string = '1,234.56'): StoredSupportingDocument => document(root, filename, 'Receipt', `Total: EUR ${total}`);
	const generic: StoredSupportingDocument = receipt('IMG_1234.pdf');
	const substring: StoredSupportingDocument = receipt('Orchard Workshops.pdf');
	const named: StoredSupportingDocument = receipt('2032-02-28_Órchard-Workshop_lunch.pdf');
	const wrongAmount: StoredSupportingDocument = receipt('Orchard Workshop.pdf', '1,234.57');
	generic.id = '00000000-0000-4000-8000-000000000001';
	substring.id = '00000000-0000-4000-8000-000000000002';
	assert.equal(named.result.sections[0].merchants.length, 0);
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [generic, substring, named, wrongAmount])]);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	await session.dispatch({ type: 'open' });
	const { transactionId }: { rowId: string; transactionId: string; } = bank.transactions[0];
	const savedMatch: TransactionMatch = session.matchResults().find((match: TransactionMatch): boolean => match.transactionId === transactionId)!;
	assert.equal(savedMatch.status, 'uncertain');
	assert.equal(savedMatch.candidates[0].documentId, generic.id);
	const revision: number = session.state().workspace!.matchRevision;
	const details: MatchDetails = session.matchDetails(revision, transactionId)!;
	assert.deepEqual(details.candidates.map((candidate: MatchCandidateView): string => candidate.documentId), [named.id, substring.id, wrongAmount.id, generic.id]);
	const bankText: string = booking.counterpartyCandidate?.value ?? booking.description.value;
	assert.deepEqual(details.candidates.map((candidate: MatchCandidateView): "partial" | "match" | "missing" | "different" => candidate.signals.filename.state), ['match', 'partial', 'match', 'missing']);
	assert.equal(details.candidates[0].signals.filename.bankText, bankText);
	assert.equal(details.candidates[2].signals.amount, 'close');
	assert.equal(session.state().workspace?.dirty, false);
});

test('combines independent signals for existing workspaces with no exact amount match', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'signals.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const booking: TransactionCandidate = bank.result.transactions[0];
	booking.description.value = 'Vela Restaurant New';
	booking.counterpartyCandidate = null;
	booking.reportedOriginalAmount = null;
	booking.accountAmount.value = { coefficient: '-17677', scale: 2, currency: 'EUR' };
	const named: StoredSupportingDocument = document(root, 'Vela-Backyard.pdf', 'Vela Backyard', 'Total: EUR 160.70');
	const reference: StoredSupportingDocument = document(root, 'other-merchant.pdf', 'Invoice', 'Merchant: Other Merchant', 'Invoice Number: SYNTHETIC-A', 'Invoice Total: USD 48.00');
	const dated: StoredSupportingDocument = document(root, 'Vela.pdf', 'Receipt', 'Merchant: Vela', 'Issue Date: 2032-02-27', 'Receipt Number: UNRELATED');
	const near: StoredSupportingDocument = document(root, 'Different-Shop.pdf', 'Receipt', 'Issue Date: 2032-02-28', 'Total: EUR 167.00');
	const generic: StoredSupportingDocument = document(root, 'IMG_1234.pdf', 'Receipt', 'Total: EUR 160.70');
	const large: StoredSupportingDocument = document(root, 'Vela Large.pdf', 'Receipt', 'Total: EUR 80.00');
	assert.equal(named.result.sections[0].kind, 'unknown');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [named, reference, dated, near, generic, large])]);
	const savedBytes: NonSharedBuffer = await readFile(file);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	await session.dispatch({ type: 'open' });
	const { transactionId }: { rowId: string; transactionId: string; } = bank.transactions[0];
	const revision: number = session.state().workspace!.matchRevision;
	assert.equal(session.matchResults().find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.status, 'unmatched');
	assert.equal(session.matchSummaries(revision)?.find((row: MatchSummary): boolean => row.transactionId === transactionId)?.status, 'uncertain');
	const candidates: Map<string, MatchCandidateView> = new Map(session.matchDetails(revision, transactionId)?.candidates.map((candidate: MatchCandidateView): [string, MatchCandidateView] => [candidate.documentId, candidate]));
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

test('ranks a previously imported OCR receipt first when item totals recover a missing digit', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'legacy-ocr.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const booking: TransactionCandidate = bank.result.transactions[0];
	booking.description.value = "Marlow's Bar & Grill";
	booking.counterpartyCandidate = null;
	booking.reportedOriginalAmount = null;
	booking.accountAmount.value = { coefficient: '-11890', currency: 'EUR', scale: 2 };
	const receipt: StoredSupportingDocument = document(root, 'Marlows.pdf', 'Receipt', 'VAT: 3000', 'Total: 08.20');
	const result: SupportingDocument = receipt.result;
	const total: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total')!;
	const tax: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'tax')!;
	const page: ImportPage = result.input!.pages[0];
	const ocr: (text: string, x: number, y: number, width?: number) => { text: string; region: { x: number; y: number; width: number; height: number; }; method: "local-ocr"; } = (text: string, x: number, y: number, width: number = 30): { text: string; region: { x: number; y: number; width: number; height: number; }; method: "local-ocr"; } => ({ text, region: { x, y, width, height: 16 }, method: 'local-ocr' as const });
	page.spans = [
		ocr('Receipt', 40, 40), ocr('VAT: 812345000', 40, 66, 150),
		ocr('2', 35, 104), ocr('Lunch', 75, 103, 75), ocr('29.50', 400, 105, 46),
		ocr('1', 35, 127), ocr('Drinks', 75, 126, 75), ocr('19.20', 402, 129, 44),
		ocr('1', 35, 150), ocr('Dessert', 75, 150, 75), ocr('59.50', 402, 151, 44),
		ocr('Total', 90, 187, 50), ocr('08.20', 371, 189, 75),
		ocr('Food 9% 4.50', 90, 216, 190), ocr('Drinks 9% 2.10', 90, 239, 190), ocr('All Taxes are Included', 90, 275, 220),
	];
	tax.candidates = [{ coefficient: '812345000', currency: 'EUR', scale: 0 }];
	tax.evidence = [{ region: page.spans[1].region, pageId: page.pageId, method: 'local-ocr', rawText: page.spans[1].text }];
	total.candidates = [{ coefficient: '820', currency: null, scale: 2 }];
	total.evidence = [{ pageId: page.pageId, region: { x: 90, y: 187, width: 356, height: 18 }, method: 'local-ocr', rawText: 'Total 08.20' }];
	result.issues.push({ code: 'missing-currency', severity: 'warning', message: 'Missing currency', sectionId: result.sections[0].sectionId,
		fieldId: total.id, field: total.role, evidence: total.evidence });
	const other: StoredSupportingDocument = document(root, 'Another-Bistro.pdf', 'Receipt', 'Issue Date: 2032-02-24', 'Total: EUR 130.00');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt, other])]);
	const savedBytes: NonSharedBuffer = await readFile(file);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	assert.equal((await session.dispatch({ type: 'open' })).error, null);

	const display: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = session.documentImports()[0].files[0];
	assert.equal(display.status, 'imported');
	if (display.status !== 'imported') {
		assert.fail();
	}
	const shown: SupportingDocument = display.record.result;
	assert.deepEqual(shown.sections[0].amounts.map((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] => [field.role, field.candidates[0].coefficient]), [
		['billed-total', '10820'], ['tax', '450'], ['tax', '210'],
	]);
	assert.ok(shown.issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total' && issue.fieldId === total.id));
	assert.ok(shown.input!.pages[0].spans.some((span: PositionedSpan): boolean => span.text === 'VAT: 812345000'));
	const model: SupportingDocumentState = new SupportingDocumentState(result);
	assert.deepEqual(model.original.sections[0].amounts, [tax, total]);
	assert.deepEqual(model.automatic, shown);
	assert.deepEqual(model.automatic.sections[0].amounts, new SupportingDocumentState(result).automatic.sections[0].amounts);
	assert.strictEqual(model.effective, model.automatic);
	assert.strictEqual(model.automatic.input, model.original.input);

	const sectionId: string = result.sections[0].sectionId;
	const correction: (fieldId: string, coefficient: string) => DocumentCorrection = (fieldId: string, coefficient: string): DocumentCorrection => ({
		documentId: receipt.id, sectionId, fieldId, revision: 2, change: { kind: 'amount', value: { coefficient, currency: 'EUR', scale: 2 } },
	});
	const edited: SupportingDocumentState = new SupportingDocumentState(result, [correction(total.id, '10900'), correction(tax.id, '395')]);
	assert.deepEqual(edited.automatic, model.automatic);
	assert.equal(edited.effective.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === total.id)?.candidates[0].coefficient, '10900');
	assert.equal(edited.effective.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === tax.id)?.candidates[0].coefficient, '395');
	const derivedTax: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = model.automatic.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'tax')!;
	assert.throws((): SupportingDocument => new SupportingDocumentState(result, [correction(derivedTax.id, '395')]).effective, /not available/);
	assert.equal(model.original.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === total.id)?.candidates[0].coefficient, '820');
	const fresh: SupportingDocument = interpretSupportingDocument(result.input);
	const imported: SupportingDocumentState = new SupportingDocumentState(fresh);
	assert.strictEqual(imported.automatic, fresh);
	assert.equal(imported.effective.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total')?.candidates[0].coefficient, '10820');

	const { transactionId }: { rowId: string; transactionId: string; } = bank.transactions[0];
	let revision: number = session.state().workspace!.matchRevision;
	const candidates: MatchCandidateView[] = session.matchDetails(revision, transactionId)!.candidates;
	assert.deepEqual(candidates.map((candidate: MatchCandidateView): string => candidate.documentId), [receipt.id, other.id]);
	assert.deepEqual(candidates[0].amounts[0].documentAmount, { coefficient: '10820', currency: 'EUR', scale: 2 });
	assert.equal(candidates[0].signals.filename.state, 'partial');
	assert.ok(candidates[0].documentEvidence.some((evidence: MatchSourceExcerpt): boolean => evidence.text.includes('29.50')));
	const summary: MatchSummary = session.matchSummaries(revision)!.find((row: MatchSummary): boolean => row.transactionId === transactionId)!;
	assert.equal(summary.status, 'uncertain');
	assert.equal(summary.review.status, 'open');
	assert.deepEqual(await readFile(file), savedBytes);
	assert.equal((await session.dispatch({ type: 'review-match', revision, transactionId, review: { status: 'assigned', documentId: receipt.id } })).error, null);
	const workspace: WorkspaceView = session.state().workspace!;
	const selection: MatchApprovalSelection = session.matchSummaries(workspace.matchRevision)!.find((row: MatchSummary): boolean => row.transactionId === transactionId)!.approvalSelection!;
	assert.equal((await session.dispatch({ type: 'approve-matches', loadRevision: workspace.loadRevision, selections: [selection] })).error, null);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved: SavedWorkspace = await loadWorkspace(file);
	assert.equal(saved.matches.find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.status, 'unmatched');
	assert.deepEqual(saved.documentImports[0].files[0], { status: 'imported', record: receipt });
	const exported: import('../../electron/reconciliation-csv.js').ReconciliationRow = reconciliationRows(saved).find((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): boolean => row.transaction_id === transactionId)!;
	assert.equal(exported.document_file, 'Marlows.pdf');
	assert.equal(exported.match_status, 'uncertain');
	assert.equal(exported.approval_status, 'approved');

	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	revision = session.state().workspace!.matchRevision;
	assert.equal(session.matchDetails(revision, transactionId)?.candidates[0].documentId, receipt.id);
	assert.equal(session.matchSummaries(revision)?.find((row: MatchSummary): boolean => row.transactionId === transactionId)?.approvalStatus.status, 'approved');

	assert.equal((await session.dispatch({ type: 'correct-document-field', revision, documentId: receipt.id,
		sectionId: result.sections[0].sectionId, fieldId: total.id, change: { kind: 'amount', value: { coefficient: '100', currency: 'EUR', scale: 2 } } })).error, null);
	revision = session.state().workspace!.matchRevision;
	assert.deepEqual(session.matchDetails(revision, transactionId)!.candidates.map((candidate: MatchCandidateView): string => candidate.documentId), [other.id]);
});

test.for(['Date', 'ORIGINAL'])('recovers an OCR date using %s in match suggestions for an already imported receipt', async (label: string, context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'split-date.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const booking: TransactionCandidate = bank.result.transactions[0];
	booking.description.value = 'Orchard Workshop Ltd 1';
	booking.counterpartyCandidate = null;
	const receipt: StoredSupportingDocument = document(root, 'Orchard-Workshop.pdf', 'Orchard Workshop', label === 'Date' ? '27/02/2032 Original' : '27 Feb 2032');
	const page: ImportPage = receipt.result.input!.pages[0];
	page.spans[1].method = 'local-ocr';
	const date: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } = receipt.result.sections[0].dates[0];
	date.evidence[0].method = 'local-ocr';
	if (label === 'Date') {
		page.spans.push({ text: label, region: { x: 4, y: 59.5, width: 20, height: 10.5 }, method: 'local-ocr' });
	} else {
		page.spans[1].region.width = date.evidence[0].region.width = 95;
		page.spans.push(
			{ text: 'SUBTOTAL', region: { x: 30, y: 20, width: 77, height: 12 }, method: 'local-ocr' },
			{ text: label, region: { x: 35, y: 38, width: 65, height: 12 }, method: 'local-ocr' },
			{ text: '20:26', region: { x: 138, y: 58, width: 40, height: 12 }, method: 'local-ocr' },
		);
	}
	assert.equal(date.role, 'unknown');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt])]);
	const savedBytes: NonSharedBuffer = await readFile(file);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	await session.dispatch({ type: 'open' });
	const { transactionId }: { rowId: string; transactionId: string; } = bank.transactions[0];
	const revision: number = session.state().workspace!.matchRevision;
	assert.equal(session.matchSummaries(revision)?.find((row: MatchSummary): boolean => row.transactionId === transactionId)?.status, 'uncertain');
	const candidate: MatchCandidateView | undefined = session.matchDetails(revision, transactionId)?.candidates[0];
	assert.equal(candidate?.documentId, receipt.id);
	assert.equal(candidate?.date?.documentDate, '2032-02-27');
	assert.equal(candidate?.date?.daysApart, 1);
	assert.ok(candidate?.documentEvidence.some((item: MatchSourceExcerpt): boolean => item.text === label));
	assert.deepEqual(await readFile(file), savedBytes);
});

test('recomputes the workspace snapshot on each successful import and saves it only on explicit Save', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'matches.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	let nextDocument: StoredDocumentImport | null = documentRun(root, [invoice(root, 'first.pdf')]);
	const session: WorkspaceSession = new WorkspaceSession(
		{ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') },
		undefined,
		{ run: async (): Promise<{ status: "imported"; record: StoredBankImport; }> => Promise.resolve(({ status: 'imported', record: bank })) },
		{ run: async (): Promise<StoredDocumentImport | null> => Promise.resolve(nextDocument) },
	);
	await session.dispatch({ type: 'new' });
	await session.dispatch({ type: 'import-statement' });
	assert.deepEqual(session.matchResults().map((match: TransactionMatch): "uncertain" | "reliable" | "unmatched" => match.status), ['unmatched', 'unmatched']);
	await session.dispatch({ type: 'import-documents' });
	const first: TransactionMatch[] = session.matchResults();
	const transactionId: string = bank.transactions[0].transactionId;
	const firstRevision: number = session.state().workspace!.matchRevision;
	assert.equal(first.find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.status, 'reliable');
	assert.equal(session.matchSummaries(firstRevision)?.find((row: MatchSummary): boolean => row.transactionId === transactionId)?.candidateCount, 1);
	const projected: MatchDetails | null = session.matchDetails(firstRevision, transactionId);
	assert.equal(projected?.candidates[0].documentEvidence.some((item: MatchSourceExcerpt): boolean => item.page === 1 && item.text.includes('SYNTHETIC-A')), true);
	await session.dispatch({ type: 'save' });
	assert.deepEqual((await loadWorkspace(file)).matches, first);
	const savedBytes: NonSharedBuffer = await readFile(file);

	nextDocument = documentRun(root, [invoice(root, 'second.pdf')]);
	nextDocument.status = 'cancelled';
	await session.dispatch({ type: 'import-documents' });
	const competing: TransactionMatch[] = session.matchResults();
	assert.equal(competing.find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.status, 'uncertain');
	assert.equal(competing.find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.candidates.length, 2);
	assert.equal(session.matchSummaries(firstRevision), null);
	assert.equal(session.matchDetails(firstRevision, transactionId), null);
	assert.deepEqual(await readFile(file), savedBytes);
	await session.dispatch({ type: 'save' });
	await session.dispatch({ type: 'new' });
	assert.deepEqual(session.matchResults(), []);
	await session.dispatch({ type: 'open' });
	assert.deepEqual(session.matchResults(), competing);
	assert.equal(session.state().workspace?.dirty, false);
	const db: Database.Database = new Database(file, { readonly: true });
	try {
		const rows: { record_json: string; }[] = db.prepare('SELECT record_json FROM match_results ORDER BY transaction_id').all() as { record_json: string }[];
		assert.deepEqual(rows.map((row: { record_json: string; }): unknown => JSON.parse(row.record_json) as unknown), competing);
		assert.deepEqual(db.prepare('SELECT * FROM associations').all(), []);
	} finally {
		db.close();
	}
});

test('opens version 3 without writing, suppresses coalesced legacy sections and upgrades on explicit Save', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'legacy.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const legacyOnOnePage: StoredSupportingDocument = document(root, 'legacy.pdf', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Total: EUR 1,234.56', 'Invoice',
		'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28');
	const legacyAcrossPages: StoredSupportingDocument = document(root, 'legacy-paged.pdf', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Total: EUR 1,234.56');
	const secondPage: ImportPage = document(root, 'second-page.pdf', 'Merchant: Cedar Workshop', 'Invoice', 'Merchant: Cedar Workshop',
		'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28').result.input!.pages[0];
	legacyAcrossPages.result.input!.pages.push({ ...secondPage, pageId: 'page-2', pageNumber: 2 });
	legacyAcrossPages.result = interpretSupportingDocument(legacyAcrossPages.result.input);
	for (const legacy of [legacyOnOnePage, legacyAcrossPages]) {
		const [first, second]: DocumentSection[] = legacy.result.sections;
		legacy.result.parserVersion = '1';
		legacy.result.sections = [{ ...first, pageIds: [...new Set([...first.pageIds, ...second.pageIds])],
			dates: second.dates, references: second.references, merchants: [...first.merchants, ...second.merchants] }];
		legacy.result.status = 'complete';
		legacy.result.issues = [];
	}
	const valid: StoredSupportingDocument = invoice(root, 'valid.pdf');
	const oldRun: StoredDocumentImport = documentRun(root, [legacyOnOnePage, legacyAcrossPages, valid]);
	await createWorkspace(file, newMetadata(), [bank], [oldRun]);
	const db: Database.Database = new Database(file);
	try {
		db.exec(`DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections;
			DROP TABLE match_reviews; DROP TABLE match_results; PRAGMA user_version=3;`);
	} finally {
		db.close();
	}
	const oldBytes: NonSharedBuffer = await readFile(file);
	const opened: SavedWorkspace = await loadWorkspace(file);
	assert.equal(opened.schemaVersion, 3);
	assert.deepEqual(await readFile(file), oldBytes);
	assert.deepEqual(opened.documentImports, [oldRun]);
	const match: TransactionMatch | undefined = opened.matches.find((match: TransactionMatch): boolean => match.transactionId === bank.transactions[0].transactionId);
	assert.equal(match?.status, 'reliable');
	assert.deepEqual(match.candidates.map((candidate: MatchCandidate): string => candidate.documentId), [valid.id]);
	const originalPrepare: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
	const prepare: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string): Database.Statement<[object], unknown> | Database.Statement<unknown[], unknown> {
		if (sql.startsWith('INSERT INTO match_results')) {
			throw new Error('Controlled migration write failure');
		}
		return originalPrepare(this, sql);
	});
	try {
		await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(opened, opened.metadata), /Controlled migration write failure/);
	} finally {
		prepare.mockRestore();
	}
	assert.deepEqual(await readFile(file), oldBytes);
	assert.equal((await loadWorkspace(file)).schemaVersion, 3);
	const saved: SavedWorkspace = await saveWorkspace(opened, opened.metadata);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual((await loadWorkspace(file)).matches, opened.matches);
	assert.deepEqual(saved.documentImports, [oldRun]);
});

test('loads persisted evidence without requiring the current engine to produce the same judgment', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'stored-judgment.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [invoice(root, 'invoice.pdf')])]);
	const historical: TransactionMatch = saved.matches.find((match: TransactionMatch): boolean => match.status === 'reliable')!;
	historical.status = 'uncertain';
	historical.candidates[0].issues = ['conflicting-evidence'];
	const db: Database.Database = new Database(file);
	try {
		db.prepare('UPDATE match_results SET record_json=? WHERE transaction_id=?').run(JSON.stringify(historical), historical.transactionId);
	} finally {
		db.close();
	}
	const loaded: SavedWorkspace = await loadWorkspace(file);
	assert.deepEqual(loaded.matches, saved.matches);
	const newDocumentImports: StoredDocumentImport[] = [...loaded.documentImports, documentRun(root, [])];
	assert.deepEqual((await saveWorkspace(loaded, loaded.metadata, loaded.imports, newDocumentImports)).matches, saved.matches);
});

test('rolls back a match write failure together with the appended import and rejects corrupt saved results', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'atomic.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [bank]);
	const before: NonSharedBuffer = await readFile(file);
	const originalPrepare: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
	const prepare: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string): Database.Statement<[object], unknown> | Database.Statement<unknown[], unknown> {
		if (sql.startsWith('INSERT INTO match_results')) {
			throw new Error('Controlled match write failure');
		}
		return originalPrepare(this, sql);
	});
	try {
		await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, saved.metadata, [bank], [documentRun(root, [invoice(root, 'new.pdf')])]), /Controlled match write failure/);
	} finally {
		prepare.mockRestore();
	}
	assert.deepEqual(await readFile(file), before);
	assert.deepEqual((await loadWorkspace(file)).matches, saved.matches);
	const db: Database.Database = new Database(file);
	try {
		db.exec("UPDATE match_results SET record_json='{}'");
	} finally {
		db.close();
	}
	const corrupted: NonSharedBuffer = await readFile(file);
	await assert.rejects((): Promise<SavedWorkspace> => loadWorkspace(file), /suggestions do not agree/);
	assert.deepEqual(await readFile(file), corrupted);
});

test('reviews transactions independently of confidence and keeps exclusive decisions and counts after reopening', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'review.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const [{ transactionId: first }, { transactionId: second }]: { rowId: string; transactionId: string; }[] = bank.transactions;
	const suggested: StoredSupportingDocument = invoice(root, 'invoice.pdf');
	const other: StoredSupportingDocument = document(root, 'restaurant.pdf', 'Receipt', 'Total: EUR 142.00');
	const imports: StoredDocumentImport = documentRun(root, [suggested, other]);
	const session: WorkspaceSession = new WorkspaceSession(
		{ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') },
		undefined,
		{ run: async (): Promise<{ status: "imported"; record: StoredBankImport; }> => Promise.resolve(({ status: 'imported', record: bank })) },
		{ run: async (): Promise<StoredDocumentImport> => Promise.resolve(imports) },
	);
	const revision: () => number = (): number => session.state().workspace!.matchRevision;

	const review: (transactionId: string, decision: MatchReview, at?: number) => Promise<WorkspaceState> = (transactionId: string, decision: MatchReview, at: number = revision()): Promise<WorkspaceState> =>
		session.dispatch(commandSchema.parse({ type: 'review-match', revision: at, transactionId, review: decision }));

	const row: (transactionId: string) => MatchSummary | undefined = (transactionId: string): MatchSummary | undefined => session.matchSummaries(revision())?.find((item: MatchSummary): boolean => item.transactionId === transactionId);

	const counts: () => MatchReviewCounts = (): MatchReviewCounts => session.state().workspace!.matchReviewCounts;
	await session.dispatch({ type: 'new' });
	await session.dispatch({ type: 'import-statement' });
	await session.dispatch({ type: 'import-documents' });
	const suggestions: TransactionMatch[] = session.matchResults();
	assert.equal(row(first)?.status, 'reliable');
	assert.deepEqual(counts(), { open: 2, assigned: 0, 'completed-without-document': 0 });
	assert.equal(row(first)?.review.status, 'open');
	const initialRevision: number = revision();
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
	const savedRevision: number = revision();
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

test('opens version 4 without writing and saves review decisions and migration atomically', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'v4-review.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const [{ transactionId: first }, { transactionId: second }]: { rowId: string; transactionId: string; }[] = bank.transactions;
	const document: StoredSupportingDocument = invoice(root, 'invoice.pdf');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [document])]);
	const db: Database.Database = new Database(file);
	try {
		db.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews; PRAGMA user_version=4;');
	} finally {
		db.close();
	}
	const bytes: NonSharedBuffer = await readFile(file);
	const opened: SavedWorkspace = await loadWorkspace(file);
	assert.equal(opened.schemaVersion, 4);
	assert.equal(opened.matchDecisions.size, 0);
	assert.deepEqual(await readFile(file), bytes);
	const save: (decisions: Map<string, string | null>) => Promise<SavedWorkspace> = (decisions: Map<string, string | null>): Promise<SavedWorkspace> => saveWorkspace(opened, opened.metadata, opened.imports, opened.documentImports, decisions);
	await assert.rejects((): Promise<SavedWorkspace> => save(new Map([[first, document.id], [second, document.id]])), /already assigned/);
	const decisions: Map<string, string | null> = new Map([[first, document.id], [second, null]]);
	const originalPrepare: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
	const prepare: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string): Database.Statement<[object], unknown> | Database.Statement<unknown[], unknown> {
		if (sql.startsWith('INSERT INTO match_reviews')) {
			throw new Error('Controlled review write failure');
		}
		return originalPrepare(this, sql);
	});
	try {
		await assert.rejects((): Promise<SavedWorkspace> => save(decisions), /Controlled review write failure/);
	} finally {
		prepare.mockRestore();
	}
	assert.deepEqual(await readFile(file), bytes);
	await save(decisions);
	const migrated: SavedWorkspace = await loadWorkspace(file);
	assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(migrated.matchDecisions, decisions);
	assert.deepEqual(migrated.matches, opened.matches);
});

test('corrects booking values with exact money, retains original evidence and promotes only resolved drafts', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'booking-corrections.receiptmatch');
	const input: BankImportInput = statement();
	input.pages[0].spans.push(...bankRow(335, '26 Feb 2032', 'To: Cedar Tools', null, null), ...bankRow(385, '25 Feb 2032', '', null, null).filter((span: PositionedSpan): string => span.text));
	const bank: StoredBankImport = retainedBank(root, input);
	const bankBefore: StoredBankImport = structuredClone(bank);
	const [first]: { rowId: string; transactionId: string; }[] = bank.transactions;
	const [draft, blocked]: { rowId: string; draftId: string; }[] = bank.drafts;
	assert.ok(first && draft && blocked);
	const documents: StoredDocumentImport = documentRun(root, [invoice(root, 'invoice.pdf')]);
	const created: SavedWorkspace = await createWorkspace(file, newMetadata(), [bank], [documents]);
	const db: Database.Database = new Database(file);
	try {
		db.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; PRAGMA user_version=5;');
	} finally {
		db.close();
	}
	const before: NonSharedBuffer = await readFile(file);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	await session.dispatch({ type: 'open' });
	const state: () => WorkspaceView = (): WorkspaceView => session.state().workspace!;

	const correct: (rowId: string, changes: { bookingDate?: string; accountAmount?: { currency: string; coefficient: string; scale: number; }; }, revision?: number) => Promise<WorkspaceState> = (rowId: string, changes: { bookingDate?: string; accountAmount?: { currency: string; coefficient: string; scale: number } }, revision: number = state().matchRevision): Promise<WorkspaceState> =>
		session.dispatch(commandSchema.parse({ type: 'correct-bank-row', rowId, revision, changes }));

	const summary: (id: string) => MatchSummary | undefined = (id: string): MatchSummary | undefined => session.matchSummaries(state().matchRevision)?.find((row: MatchSummary): boolean => row.transactionId === id);
	assert.equal((await loadWorkspace(file)).schemaVersion, 5);
	assert.deepEqual(await readFile(file), before);
	assert.equal(summary(first.transactionId)?.status, 'reliable');
	const originalDate: string = summary(first.transactionId)!.bookingDate;
	const revision: number = state().matchRevision;
	await correct(first.transactionId, { bookingDate: originalDate });
	assert.equal(state().matchRevision, revision);
	assert.equal(state().dirty, false);
	assert.match((await correct(first.transactionId, { accountAmount: { currency: 'USD', coefficient: '-25620', scale: 2 } })).error!, /account currency/);
	assert.equal((await correct(first.transactionId, { bookingDate: '2032-04-30' })).error, null);
	assert.equal(summary(first.transactionId)?.bookingDate, '2032-04-30');
	assert.equal(summary(first.transactionId)?.bankValuesCorrected, true);
	const changedDate: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null | undefined = session.matchDetails(state().matchRevision, first.transactionId)?.candidates[0].date;
	assert.equal(changedDate?.bookingDate, '2032-04-30');
	assert.equal(changedDate?.withinWindow, false);
	assert.match((await correct(first.transactionId, { bookingDate: originalDate }, revision)).error!, /Refresh/);
	assert.equal((await correct(first.transactionId, { accountAmount: { currency: 'EUR', coefficient: '-25620', scale: 2 } })).error, null);
	assert.equal(summary(first.transactionId)?.status, 'uncertain');
	const referenceOnly: MatchCandidateView | undefined = session.matchDetails(state().matchRevision, first.transactionId)?.candidates[0];
	assert.equal(referenceOnly?.signals.reference, 'match');
	assert.equal(referenceOnly?.signals.amount, 'different');
	const correctedRevision: number = state().matchRevision;
	await correct(first.transactionId, { accountAmount: { currency: 'EUR', coefficient: '-256200', scale: 3 } });
	assert.equal(state().matchRevision, correctedRevision);
	const exact: { currency: string; coefficient: string; scale: number; } = { currency: 'EUR', coefficient: '-900719925474099327', scale: 2 };
	assert.equal((await correct(draft.draftId, { accountAmount: exact })).error, null);
	assert.deepEqual(summary(draft.draftId)?.accountAmount, exact);
	assert.equal(state().imports[0].transactions, 3);
	assert.equal((await correct(blocked.draftId, { accountAmount: exact })).error, null);
	assert.equal(summary(blocked.draftId), undefined);
	assert.equal(state().imports[0].drafts, 1);
	assert.deepEqual(session.bankImports(), [bankBefore]);
	assert.deepEqual(await readFile(file), before);
	const review: WorkspaceState = await session.dispatch({ type: 'review-match', transactionId: draft.draftId, revision: state().matchRevision, review: { status: 'completed-without-document' } });
	assert.equal(review.error, null);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	const saved: SavedWorkspace = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.equal(saved.bankCorrections.get(first.transactionId)?.revision, 3);
	assert.deepEqual(saved.imports, created.imports);
	assert.deepEqual(summary(draft.draftId)?.review, { status: 'completed-without-document' });
	assert.deepEqual(summary(draft.draftId)?.accountAmount, exact);
	assert.equal(state().dirty, false);
	const check: Database.Database = new Database(file, { readonly: true });
	try {
		assert.deepEqual(check.prepare('SELECT coefficient, revision FROM transactions WHERE id=?').get(draft.draftId), { coefficient: exact.coefficient, revision: 2 });
	} finally {
		check.close();
	}
});

test('recalculates matches from corrected document fields and saves originals, revisions and review decisions atomically', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const file: string = path.join(root, 'document-corrections.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	const transactionId: string = bank.transactions[0].transactionId;
	const receipt: StoredSupportingDocument = document(root, 'original.pdf', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-31', 'Invoice Total: EUR 98.00');
	const missing: StoredSupportingDocument = document(root, 'missing.pdf', 'Receipt', 'Merchant: River Studio');
	const source: StoredDocumentImport = documentRun(root, [receipt, missing]);
	await createWorkspace(file, newMetadata(), [bank], [source]);
	const db: Database.Database = new Database(file);
	try {
		db.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; PRAGMA user_version=6;');
	} finally {
		db.close();
	}
	const before: NonSharedBuffer = await readFile(file);
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	assert.equal((await loadWorkspace(file)).schemaVersion, 6);
	assert.deepEqual(await readFile(file), before);
	const state: () => WorkspaceView = (): WorkspaceView => session.state().workspace!;
	const { sectionId, amounts, dates }: DocumentSection = receipt.result.sections[0];
	assert.deepEqual(dates[0].candidates, []);
	const revision: number = state().matchRevision;
	const correct: (fieldId: string | null, change: DocumentCorrectionValue, at?: number) => Promise<WorkspaceState> = (fieldId: string | null, change: DocumentCorrectionValue, at: number = state().matchRevision): Promise<WorkspaceState> =>
		session.dispatch(commandSchema.parse({ type: 'correct-document-field', revision: at, documentId: receipt.id, sectionId, fieldId, change }));
	assert.equal(session.matchResults().find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.status, 'unmatched');
	assert.equal((await correct(amounts[0].id, { kind: 'amount', value: { coefficient: '123456', scale: 2, currency: 'EUR' } })).error, null);
	assert.match((await correct(dates[0].id, { kind: 'date', value: '2032-02-28' }, revision)).error!, /Refresh/);
	assert.match((await correct(amounts[0].id, { kind: 'date', value: '2032-02-28' })).error!, /field.*not available/);
	assert.equal((await correct(dates[0].id, { kind: 'date', value: '2032-02-28' })).error, null);
	const dateRevision: number = state().matchRevision;
	await correct(amounts[0].id, { kind: 'amount', value: { coefficient: '1234560', scale: 3, currency: 'EUR' } });
	assert.equal(state().matchRevision, dateRevision);
	const candidate: MatchCandidateView | undefined = session.matchDetails(dateRevision, transactionId)?.candidates[0];
	assert.equal(candidate?.documentValuesCorrected, true);
	assert.equal(candidate?.date?.documentDate, '2032-02-28');
	assert.ok(candidate?.documentEvidence.some((item: MatchSourceExcerpt): boolean => item.text.includes('EUR 98.00')));
	assert.equal(session.matchResults().find((match: TransactionMatch): boolean => match.transactionId === transactionId)?.status, 'reliable');
	const added: WorkspaceState = await session.dispatch({ type: 'correct-document-field', revision: dateRevision, documentId: missing.id, sectionId: missing.result.sections[0].sectionId,
		fieldId: null, change: { kind: 'amount', value: { coefficient: '900719925474099327', scale: 2, currency: 'EUR' } } });
	assert.equal(added.error, null);
	const overlays: Map<string, DocumentCorrection> = new Map(state().documentCorrections.map((item: DocumentCorrection): [string, DocumentCorrection] => [documentCorrectionKey(item, item.change.kind), item]));
	const supplied: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = applyDocumentCorrections([source], overlays)[0].files[1];
	assert.equal(supplied.status, 'imported');
	if (supplied.status !== 'imported') {
		throw new Error('Expected imported receipt');
	}
	const suppliedField: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = supplied.record.result.sections[0].amounts[0];
	assert.match((await session.dispatch({ type: 'correct-document-field', revision: state().matchRevision, documentId: missing.id,
		sectionId: missing.result.sections[0].sectionId, fieldId: suppliedField.id, change: { kind: 'amount', value: { coefficient: '1234', scale: 2, currency: 'EUR' } }
	})).error!, /field.*not available/);
	assert.deepEqual(session.documentImports(), [source]);
	assert.equal((await session.dispatch({ type: 'review-match', revision: state().matchRevision, transactionId,
		review: { status: 'assigned', documentId: receipt.id } })).error, null);
	const originalPrepare: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
	const prepare: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string): Database.Statement<[object], unknown> | Database.Statement<unknown[], unknown> {
		if (sql.startsWith('INSERT INTO match_results')) {
			throw new Error('Controlled match write failure');
		}
		return originalPrepare(this, sql);
	});
	try {
		assert.match((await session.dispatch({ type: 'save' })).error!, /Controlled match write failure/);
	} finally {
		prepare.mockRestore();
	}
	assert.deepEqual(await readFile(file), before);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	const saved: SavedWorkspace = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(saved.documentImports, [source]);
	assert.deepEqual(saved.matchDecisions.get(transactionId), receipt.id);
	assert.deepEqual([...saved.documentCorrections.values()].map((item: DocumentCorrection): number => item.revision).sort(), [2, 2, 3]);
	const effective: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = applyDocumentCorrections(saved.documentImports, saved.documentCorrections)[0].files[1];
	assert.equal(effective.status, 'imported');
	if (effective.status !== 'imported') {
		throw new Error('Expected imported receipt');
	}
	assert.deepEqual(effective.record.result.sections[0].amounts[0].evidence, []);
	assert.equal(effective.record.result.sections[0].amounts[0].candidates[0].coefficient, '900719925474099327');
	assert.ok(effective.record.result.issues.some((issue: DocumentIssue): boolean => issue.field === 'issue'));
	const check: Database.Database = new Database(file, { readonly: true });
	try {
		assert.deepEqual(check.prepare('SELECT revision FROM documents WHERE id=?').get(receipt.id), { revision: 3 });
	} finally {
		check.close();
	}
});

test('keeps both fields in review when a correction makes agreeing document totals conflict', async (context: TestContext & object): Promise<void> => {
	const root: string = await directory(context);
	const original: StoredSupportingDocument = invoice(root, 'duplicate-total.pdf');
	const section: DocumentSection = original.result.sections[0];
	const first: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = section.amounts[0];
	const second: { id: string; role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; label: string; evidence: SourceEvidence[]; } = { ...first, id: 'duplicate-total' };
	section.amounts.push(second);
	const sources: StoredDocumentImport[] = [documentRun(root, [original])];
	const firstCorrection: DocumentCorrection = { documentId: original.id, sectionId: section.sectionId, fieldId: first.id, revision: 2,
		change: { kind: 'amount', value: { coefficient: '123457', scale: 2, currency: 'EUR' } } };
	const corrections: Map<string, DocumentCorrection> = new Map([[documentCorrectionKey(firstCorrection, 'amount'), firstCorrection]]);
	const corrected: () => { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = (): { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } => applyDocumentCorrections(sources, corrections)[0].files[0];
	let file: ReturnType<typeof corrected> = corrected();
	assert.equal(file.status, 'imported');
	assert.deepEqual(file.record.result.issues.filter((issue: DocumentIssue): boolean => issue.code === 'conflicting-field').map((issue: DocumentIssue): string | null => issue.fieldId), [first.id, second.id]);
	const secondCorrection: { fieldId: string; revision: number; change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; }; documentId: string; sectionId: string; } = { ...firstCorrection, fieldId: second.id, revision: 3 };
	corrections.set(documentCorrectionKey(secondCorrection, 'amount'), secondCorrection);
	file = corrected();
	assert.equal(file.status, 'imported');
	assert.equal(file.record.result.issues.some((issue: DocumentIssue): boolean => issue.code === 'conflicting-field'), false);
	assert.equal(original.result.issues.some((issue: DocumentIssue): boolean => issue.code === 'conflicting-field'), false);
});
