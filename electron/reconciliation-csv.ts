import type { StoredBankImport } from "../src/shared/workspace-import.js";
import type { StoredDocumentImport, StoredSupportingDocument } from "../src/shared/workspace-documents.js";
import type { TransactionMatch } from "../src/shared/workspace-matching.js";
import type { ImportIssue } from "../src/shared/bank-import.js";
import type { SupportingDocument } from "../src/shared/supporting-document.js";
import type { MatchApproval } from "../src/shared/match-approvals.js";
import type { MatchSummary } from "../src/shared/workspace-matching.js";
import type { ReviewMatch } from "../src/shared/workspace-matching.js";
import path from 'node:path';
import { formatAmountEntry } from '../src/shared/amount-entry.js';
import { applyBankCorrections } from '../src/shared/bank-corrections.js';
import type { TransactionCandidate, UnresolvedDraft } from '../src/shared/bank-import.js';
import type { DocumentExportOutcome } from '../src/shared/document-export.js';
import { documentRevisionIndex } from '../src/shared/match-approvals.js';
import { excludeDuplicateTransactions, excludeTransactions } from '../src/shared/transaction-duplicates.js';
import { activeStatements, activeSupportingDocuments } from '../src/shared/source-replacements.js';
import { WorkspaceDocumentState } from './documents/document-state.js';
import { summarizeMatches } from './match-view.js';
import { suggestWorkspaceMatches } from './matching.js';
import { evaluateReviewMatches } from './review-matching.js';
import type { SavedWorkspace } from './store.js';

export const reconciliationCsvColumns: readonly ["row_type", "transaction_id", "draft_id", "statement_id", "statement_file", "booking_date", "description", "account_amount", "account_currency", "original_amount", "original_currency", "review_status", "match_status", "approval_status", "approval_batch_id", "approved_at", "document_id", "document_file", "copy_status", "exported_file", "copy_reason", "import_issue_codes"] = [
	'row_type', 'transaction_id', 'draft_id', 'statement_id', 'statement_file', 'booking_date', 'description',
	'account_amount', 'account_currency', 'original_amount', 'original_currency',
	'review_status', 'match_status', 'approval_status', 'approval_batch_id', 'approved_at', 'document_id', 'document_file',
	'copy_status', 'exported_file', 'copy_reason', 'import_issue_codes',
] as const;

type ReconciliationColumn = (typeof reconciliationCsvColumns)[number];
export type ReconciliationRow = Record<ReconciliationColumn, string>;

function sourceName(file: string): string {
	return path.posix.isAbsolute(file) ? path.posix.basename(file) : path.win32.basename(file);
}

export function reconciliationRows(snapshot: SavedWorkspace, copyOutcomes: readonly DocumentExportOutcome[] = []): ReconciliationRow[] {
	const corrected: StoredBankImport[] = applyBankCorrections(snapshot.imports, snapshot.bankCorrections);
	const imports: StoredBankImport[] = excludeDuplicateTransactions(activeStatements(corrected, snapshot.sourceReplacements), snapshot.duplicateDecisions.values());
	const documentView: WorkspaceDocumentState = new WorkspaceDocumentState(snapshot.documentImports, snapshot.documentCorrections);
	const documents: StoredDocumentImport[] = activeSupportingDocuments(documentView.effective, snapshot.sourceReplacements);
	const matchImports: StoredBankImport[] = excludeTransactions(imports, snapshot.ignoredTransactions);
	const exactMatches: TransactionMatch[] = matchImports === corrected && !snapshot.sourceReplacements.size && !documentView.hasAutomaticChanges ? snapshot.matches : suggestWorkspaceMatches(matchImports, documents);
	const matches: ReviewMatch[] = evaluateReviewMatches(exactMatches, matchImports, documents);
	const documentRevisions: Map<string, number> = documentRevisionIndex(snapshot.documentCorrections.values());
	const summaries: Map<string, MatchSummary> = new Map(summarizeMatches(matches, imports, snapshot.matchDecisions, snapshot.bankCorrections, snapshot.reviewApprovals, documentRevisions, snapshot.ignoredTransactions)
		.map((summary: MatchSummary): [string, MatchSummary] => [summary.transactionId, summary]));
	const names: Map<string, string> = new Map(snapshot.documentImports.flatMap((run: StoredDocumentImport): (readonly [string, string])[] => run.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [] | [readonly [string, string]] => file.status === 'imported' ?
		[[file.record.id, sourceName(file.record.filePath)] as const] : [])));
	const copies: Map<string, DocumentExportOutcome> = new Map<string, DocumentExportOutcome>();
	for (const outcome of copyOutcomes) {
		if (copies.has(outcome.transactionId) || summaries.get(outcome.transactionId)?.approval?.documentId !== outcome.documentId) {
			throw new Error('The document copy results do not agree with the saved approvals.');
		}
		copies.set(outcome.transactionId, outcome);
	}

	const rows: ReconciliationRow[] = [];
	for (const record of imports) {
		appendStatementRows(record, summaries, names, copies, snapshot.reviewApprovals, rows);
	}
	return rows;
}

type BookingFields = Pick<ReconciliationRow, 'statement_id' | 'statement_file' | 'booking_date' | 'description' | 'account_amount' | 'account_currency' | 'original_amount' | 'original_currency'>;

function appendStatementRows(record: StoredBankImport, summaries: ReadonlyMap<string, MatchSummary>, names: ReadonlyMap<string, string>,
	copies: ReadonlyMap<string, DocumentExportOutcome>, reviewApprovals: SavedWorkspace['reviewApprovals'], rows: ReconciliationRow[]): void {
	const statements: Map<string, string> = new Map(record.accounts.map((account: { sectionId: string; accountId: string; statementId: string; }): [string, string] => [account.sectionId, account.statementId]));
	const transactions: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
	const drafts: Map<string, UnresolvedDraft> = new Map(record.result.unresolvedDrafts.map((row: UnresolvedDraft): [string, UnresolvedDraft] => [row.rowId, row]));
	const issues: Map<string, Set<string>> = new Map<string, Set<string>>();
	for (const issue of record.result.issues) {
		if (issue.rowId === null) {
			continue;
		}
		const codes: Set<string> = issues.get(issue.rowId) ?? new Set<string>();
		codes.add(issue.code);
		issues.set(issue.rowId, codes);
	}
	const statementFile: string = sourceName(record.filePath);
	const bookingFields: (row: TransactionCandidate | UnresolvedDraft) => BookingFields = (row: TransactionCandidate | UnresolvedDraft): BookingFields => {
		const amount: { coefficient: string; currency: string; scale: number; }   | undefined = row.accountAmount?.value, original: { coefficient: string; currency: string; scale: number; }   | undefined = row.reportedOriginalAmount?.value;
		return {
			statement_id: statements.get(row.accountSectionId)!, statement_file: statementFile, booking_date: row.bookingDate?.value ?? '',
			description: row.description?.value ?? '', account_amount: formatAmountEntry(amount, '.'), account_currency: amount?.currency ?? '',
			original_amount: formatAmountEntry(original, '.'), original_currency: original?.currency ?? '',
		};
	};
	for (const { rowId, transactionId } of record.transactions) {
		const row: TransactionCandidate = transactions.get(rowId)!;
		const summary: MatchSummary = summaries.get(transactionId)!;
		const issueCodes: string = [...(issues.get(rowId) ?? [])].sort().join('|');
		rows.push(transactionRow(summary, bookingFields(row), reviewApprovals.get(transactionId)?.approval, copies.get(transactionId), names, issueCodes));
	}
	for (const { rowId, draftId } of record.drafts) {
		const row: UnresolvedDraft = drafts.get(rowId)!;
		const codes: Set<string> = new Set([...(issues.get(rowId) ?? []), ...row.issues.map((issue: ImportIssue): string => issue.code)]);
		rows.push({
			row_type: 'unresolved', transaction_id: '', draft_id: draftId, ...bookingFields(row),
			review_status: '', match_status: '', approval_status: '', approval_batch_id: '', approved_at: '', document_id: '', document_file: '',
			copy_status: 'not-eligible', exported_file: '', copy_reason: '', import_issue_codes: [...codes].sort().join('|'),
		});
	}
}

function transactionRow(summary: MatchSummary, booking: BookingFields, storedApproval: MatchApproval | null | undefined, copy: DocumentExportOutcome | undefined,
	names: ReadonlyMap<string, string>, issueCodes: string): ReconciliationRow {
	const transactionId: string = summary.transactionId;
	const documentId: string = summary.review.status === 'assigned' ? summary.review.documentId : '';
	const approval: MatchApproval | null | undefined = summary.ignored || summary.approvalStatus.status === 'revoked' ? null : storedApproval;
	return {
		row_type: 'transaction', transaction_id: transactionId, draft_id: '', ...booking,
		review_status: summary.ignored ? 'ignored' : summary.review.status, match_status: summary.ignored ? '' : summary.status, approval_status: summary.approvalStatus.status,
		approval_batch_id: approval?.batchId ?? '', approved_at: approval?.approvedAt ?? '', document_id: documentId, document_file: names.get(documentId) ?? '',
		copy_status: copy?.status ?? (summary.approval ? 'not-attempted' : 'not-eligible'),
		exported_file: copy?.status === 'copied' ? 'documents/' + copy.filename : '',
		copy_reason: !copy ? '' : copy.status === 'copied' ? copy.warning ?? '' : copy.reason,
		import_issue_codes: issueCodes,
	};
}

function csvCell(column: ReconciliationColumn, value: string): string {
	if ((column === 'account_amount' || column === 'original_amount') && /^-?\d+(?:\.\d+)?$/.test(value)) {
		return value;
	}
	const first: number = value.charCodeAt(0);
	const significant: string = value.replace(/^[\p{Cc}\p{Cf}\s]+/u, '');
	const formulaLike: boolean = first < 32 || /^[=+\-@＝＋－＠]/u.test(significant);
	const text: string = formulaLike ? "'" + value : value;
	return formulaLike || /[",\t\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function serializeReconciliationCsv(rows: readonly ReconciliationRow[]): string {
	const lines: string[] = rows.map((row: ReconciliationRow): string => reconciliationCsvColumns.map((column: "description" | "row_type" | "transaction_id" | "draft_id" | "statement_id" | "statement_file" | "booking_date" | "account_amount" | "account_currency" | "original_amount" | "original_currency" | "review_status" | "match_status" | "approval_status" | "approval_batch_id" | "approved_at" | "document_id" | "document_file" | "copy_status" | "exported_file" | "copy_reason" | "import_issue_codes"): string => csvCell(column, row[column])).join(','));
	return '\uFEFF' + [reconciliationCsvColumns.join(','), ...lines].join('\r\n') + '\r\n';
}
