import type { SourceEvidence } from '../src/shared/bank-import.js';
import type { BankCorrection } from '../src/shared/bank-corrections.js';
import type { DocumentCorrection } from '../src/shared/document-corrections.js';
import { approvalSelectionFor, matchApprovalStatus, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchSourceExcerpt, MatchSummary, ReviewMatch } from '../src/shared/workspace-matching.js';
import { withGenericIssueDate } from './documents/interpret.js';

export function summarizeMatches(
	matches: ReviewMatch[], imports: StoredBankImport[], decisions: ReadonlyMap<string, string | null>, corrections: ReadonlyMap<string, BankCorrection>,
	reviewApprovals: ReadonlyMap<string, ReviewApprovalState>, documentRevisions: ReadonlyMap<string, number>, ignoredTransactions: ReadonlySet<string>,
	ignoredByRule: ReadonlySet<string> = new Set(),
): MatchSummary[] {
	const byTransaction = new Map(matches.map(match => [match.transactionId, match]));
	return imports.flatMap(record => {
		const ids = new Map(record.transactions.map(({ rowId, transactionId }) => [rowId, transactionId]));
		return record.result.transactions.map(row => {
			const transactionId = ids.get(row.rowId)!;
			const match = byTransaction.get(transactionId);
			const ignored = ignoredTransactions.has(transactionId);
			const documentId = decisions.get(transactionId);
			const reviewApproval = reviewApprovals.get(transactionId);
			const approvalSelection = documentId && !ignored ?
				approvalSelectionFor(transactionId, documentId, corrections.get(transactionId)?.revision, documentRevisions.get(documentId), reviewApproval?.associationRevision) : null;
			const approval = ignored ? null : reviewApproval?.approval ?? null;
			const approvalStatus = matchApprovalStatus(approval, approvalSelection);
			return { transactionId, bookingDate: row.bookingDate.value, description: row.description.value,
				accountAmount: row.accountAmount.value, ignored, ignoredByRule: ignoredByRule.has(transactionId), status: match?.status ?? 'unmatched', candidateCount: match?.candidates.length ?? 0, bankValuesCorrected: corrections.has(transactionId),
				approvalSelection, approvalStatus, approval: approvalStatus.status === 'approved' ? approval : null,
				review: documentId === undefined ? { status: 'open' } : documentId === null ? { status: 'completed-without-document' } : { status: 'assigned', documentId } };
		});
	});
}

function excerpts(evidence: SourceEvidence[], pages: ReadonlyMap<string, number>): MatchSourceExcerpt[] {
	const result = new Map<string, MatchSourceExcerpt>();
	for (const item of evidence) {
		const page = pages.get(item.pageId);
		if (page === undefined) continue;
		const { x, y } = item.region;
		result.set(JSON.stringify([page, x, y, item.method, item.rawText]), { page, x, y, method: item.method, text: item.rawText });
	}
	return [...result.values()].sort((left, right) => left.page - right.page || left.y - right.y || left.x - right.x);
}

export function describeMatch(
	match: ReviewMatch, imports: StoredBankImport[], documentImports: StoredDocumentImport[], corrections: ReadonlyMap<string, DocumentCorrection>,
): MatchDetails {
	const bank = imports.find(record => record.transactions.some(row => row.transactionId === match.transactionId))!;
	const rowId = bank.transactions.find(row => row.transactionId === match.transactionId)!.rowId;
	const transaction = bank.result.transactions.find(row => row.rowId === rowId)!;
	const bankPages = new Map(bank.result.sourceProvenance!.pages.map(page => [page.pageId, page.pageNumber]));
	const documents = new Map(documentImports.flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [[file.record.id, file.record] as const] : [])));
	const correctedSections = new Set([...corrections.values()].map(({ documentId, sectionId }) => JSON.stringify([documentId, sectionId])));
	const candidates: MatchDetails['candidates'] = match.candidates.map(candidate => {
		const document = documents.get(candidate.documentId)!;
		const sectionIndex = document.result.sections.findIndex(section => section.sectionId === candidate.sectionId);
		const section = document.result.sections[sectionIndex];
		const pages = document.result.input!.pages;
		const documentPages = new Map(pages.map(page => [page.pageId, page.pageNumber]));
		const dates = candidate.date?.role === 'issue' ? withGenericIssueDate(section, pages) : section.dates;
		const bankEvidence = [
			...candidate.amounts.flatMap(amount => (amount.basis === 'account-settlement' ? transaction.accountAmount : transaction.reportedOriginalAmount)!.evidence),
			...candidate.references.flatMap(reference => transaction.references.filter(field => field.label === reference.bankLabel && field.value === reference.bankValue)
				.flatMap(field => field.evidence)),
			...(candidate.date ? transaction.bookingDate.evidence : []),
			...[transaction.counterpartyCandidate, transaction.description].flatMap(field => field &&
				[candidate.signals.merchant.bankText, candidate.signals.filename.bankText].includes(field.value) ? field.evidence : []),
		];
		const fields = new Set([...candidate.amounts.map(amount => amount.documentFieldId), ...candidate.references.map(reference => reference.documentFieldId)]);
		if (candidate.date) fields.add(candidate.date.documentFieldId);
		const documentEvidence = [...section.amounts, ...section.references, ...dates].filter(field => fields.has(field.id)).flatMap(field => field.evidence);
		documentEvidence.push(...section.merchants.filter(field => field.candidates.includes(candidate.signals.merchant.documentText ?? '')).flatMap(field => field.evidence));
		if (candidate.issues.includes('conflicting-evidence')) {
			const roles = new Set(section.amounts.filter(field => fields.has(field.id)).map(field => field.role));
			const referenceRoles = new Set(section.references.filter(field => fields.has(field.id)).map(field => field.role));
			const relatedFields = [...section.amounts.filter(field => roles.has(field.role)), ...section.references.filter(field => referenceRoles.has(field.role)),
				...dates.filter(field => field.role === 'issue' || field.role === 'payment'), ...section.currencies.filter(field => field.role === 'settlement'), ...section.merchants];
			const relatedIds = new Set(relatedFields.map(field => field.id));
			documentEvidence.push(...relatedFields.flatMap(field => field.evidence));
			for (const issue of document.result.issues) if (issue.fieldId && relatedIds.has(issue.fieldId)) documentEvidence.push(...issue.evidence);
		}
		return { ...candidate, filePath: document.filePath,
			sectionKind: section.kind, sectionNumber: document.result.sections.length > 1 ? sectionIndex + 1 : null,
			documentValuesCorrected: correctedSections.has(JSON.stringify([candidate.documentId, candidate.sectionId])),
			pages: section.pageIds.map(id => documentPages.get(id)!), bankEvidence: excerpts(bankEvidence, bankPages), documentEvidence: excerpts(documentEvidence, documentPages) };
	});
	return { statementPath: bank.filePath, candidates };
}
