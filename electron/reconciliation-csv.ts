import path from 'node:path';
import { formatAmountEntry } from '../src/shared/amount-entry.js';
import { applyBankCorrections } from '../src/shared/bank-corrections.js';
import type { TransactionCandidate, UnresolvedDraft } from '../src/shared/bank-import.js';
import { applyDocumentCorrections } from '../src/shared/document-corrections.js';
import type { DocumentExportOutcome } from '../src/shared/document-export.js';
import { documentRevisionIndex } from '../src/shared/match-approvals.js';
import { summarizeMatches } from './match-view.js';
import { evaluateReviewMatches } from './review-matching.js';
import type { SavedWorkspace } from './store.js';

export const reconciliationCsvColumns = [
	'row_type', 'transaction_id', 'draft_id', 'statement_id', 'statement_file', 'booking_date', 'description',
	'account_amount', 'account_currency', 'original_amount', 'original_currency',
	'review_status', 'match_status', 'approval_status', 'approval_batch_id', 'approved_at', 'document_id', 'document_file',
	'copy_status', 'exported_file', 'copy_reason', 'import_issue_codes',
] as const;

type ReconciliationColumn = (typeof reconciliationCsvColumns)[number];
type ReconciliationRow = Record<ReconciliationColumn, string>;

function sourceName(file: string): string {
	return path.posix.isAbsolute(file) ? path.posix.basename(file) : path.win32.basename(file);
}

export function reconciliationRows(snapshot: SavedWorkspace, copyOutcomes: readonly DocumentExportOutcome[] = []): ReconciliationRow[] {
	const imports = applyBankCorrections(snapshot.imports, snapshot.bankCorrections);
	const documents = applyDocumentCorrections(snapshot.documentImports, snapshot.documentCorrections);
	const matches = evaluateReviewMatches(snapshot.matches, imports, documents);
	const documentRevisions = documentRevisionIndex(snapshot.documentCorrections.values());
	const summaries = new Map(summarizeMatches(matches, imports, snapshot.matchDecisions, snapshot.bankCorrections, snapshot.reviewApprovals, documentRevisions)
		.map(summary => [summary.transactionId, summary]));
	const names = new Map(snapshot.documentImports.flatMap(run => run.files.flatMap(file => file.status === 'imported' ?
		[[file.record.id, sourceName(file.record.filePath)] as const] : [])));
	const copies = new Map<string, DocumentExportOutcome>();
	for (const outcome of copyOutcomes) {
		if (copies.has(outcome.transactionId) || summaries.get(outcome.transactionId)?.approval?.documentId !== outcome.documentId) {
			throw new Error('The document copy results do not agree with the saved approvals.');
		}
		copies.set(outcome.transactionId, outcome);
	}

	const rows: ReconciliationRow[] = [];
	for (const record of imports) {
		const statements = new Map(record.accounts.map(account => [account.sectionId, account.statementId]));
		const transactions = new Map(record.result.transactions.map(row => [row.rowId, row]));
		const drafts = new Map(record.result.unresolvedDrafts.map(row => [row.rowId, row]));
		const issues = new Map<string, Set<string>>();
		for (const issue of record.result.issues) {
			if (issue.rowId === null) continue;
			const codes = issues.get(issue.rowId) ?? new Set<string>();
			codes.add(issue.code);
			issues.set(issue.rowId, codes);
		}
		const statementFile = sourceName(record.filePath);
		const bookingFields = (row: TransactionCandidate | UnresolvedDraft) => {
			const amount = row.accountAmount?.value, original = row.reportedOriginalAmount?.value;
			return {
				statement_id: statements.get(row.accountSectionId)!, statement_file: statementFile, booking_date: row.bookingDate?.value ?? '',
				description: row.description?.value ?? '', account_amount: formatAmountEntry(amount, '.'), account_currency: amount?.currency ?? '',
				original_amount: formatAmountEntry(original, '.'), original_currency: original?.currency ?? '',
			};
		};
		for (const { rowId, transactionId } of record.transactions) {
			const row = transactions.get(rowId)!;
			const summary = summaries.get(transactionId)!;
			const documentId = summary.review.status === 'assigned' ? summary.review.documentId : '';
			const approval = summary.approvalStatus.status === 'revoked' ? null : snapshot.reviewApprovals.get(transactionId)?.approval;
			const copy = copies.get(transactionId);
			rows.push({
				row_type: 'transaction', transaction_id: transactionId, draft_id: '', ...bookingFields(row),
				review_status: summary.review.status, match_status: summary.status, approval_status: summary.approvalStatus.status,
				approval_batch_id: approval?.batchId ?? '', approved_at: approval?.approvedAt ?? '', document_id: documentId, document_file: names.get(documentId) ?? '',
				copy_status: copy?.status ?? (summary.approval ? 'not-attempted' : 'not-eligible'),
				exported_file: copy?.status === 'copied' ? 'documents/' + copy.filename : '',
				copy_reason: !copy ? '' : copy.status === 'copied' ? copy.warning ?? '' : copy.reason,
				import_issue_codes: [...(issues.get(rowId) ?? [])].sort().join('|'),
			});
		}
		for (const { rowId, draftId } of record.drafts) {
			const row = drafts.get(rowId)!;
			const codes = new Set([...(issues.get(rowId) ?? []), ...row.issues.map(issue => issue.code)]);
			rows.push({
				row_type: 'unresolved', transaction_id: '', draft_id: draftId, ...bookingFields(row),
				review_status: '', match_status: '', approval_status: '', approval_batch_id: '', approved_at: '', document_id: '', document_file: '',
				copy_status: 'not-eligible', exported_file: '', copy_reason: '', import_issue_codes: [...codes].sort().join('|'),
			});
		}
	}
	return rows;
}

function csvCell(column: ReconciliationColumn, value: string): string {
	if ((column === 'account_amount' || column === 'original_amount') && /^-?\d+(?:\.\d+)?$/.test(value)) return value;
	const first = value.charCodeAt(0);
	const significant = value.replace(/^[\p{Cc}\p{Cf}\s]+/u, '');
	const formulaLike = first < 32 || /^[=+\-@＝＋－＠]/u.test(significant);
	const text = formulaLike ? "'" + value : value;
	return formulaLike || /[",\t\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function serializeReconciliationCsv(rows: readonly ReconciliationRow[]): string {
	const lines = rows.map(row => reconciliationCsvColumns.map(column => csvCell(column, row[column])).join(','));
	return '\uFEFF' + [reconciliationCsvColumns.join(','), ...lines].join('\r\n') + '\r\n';
}
