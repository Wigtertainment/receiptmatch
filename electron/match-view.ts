import type { SourceEvidence } from '../src/shared/bank-import.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchSourceExcerpt, MatchSummary, TransactionMatch } from '../src/shared/workspace-matching.js';

export function summarizeMatches(matches: TransactionMatch[], imports: StoredBankImport[]): MatchSummary[] {
	const byTransaction = new Map(matches.map(match => [match.transactionId, match]));
	return imports.flatMap(record => {
		const ids = new Map(record.transactions.map(({ rowId, transactionId }) => [rowId, transactionId]));
		return record.result.transactions.map(row => {
			const transactionId = ids.get(row.rowId)!;
			const match = byTransaction.get(transactionId)!;
			return { transactionId, bookingDate: row.bookingDate.value, description: row.description.value,
				accountAmount: row.accountAmount.value, status: match.status, candidateCount: match.candidates.length };
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

export function describeMatch(match: TransactionMatch, imports: StoredBankImport[], documentImports: StoredDocumentImport[]): MatchDetails {
	const bank = imports.find(record => record.transactions.some(row => row.transactionId === match.transactionId))!;
	const rowId = bank.transactions.find(row => row.transactionId === match.transactionId)!.rowId;
	const transaction = bank.result.transactions.find(row => row.rowId === rowId)!;
	const bankPages = new Map(bank.result.sourceProvenance!.pages.map(page => [page.pageId, page.pageNumber]));
	const documents = new Map(documentImports.flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [[file.record.id, file.record] as const] : [])));
	return { statementPath: bank.filePath, candidates: match.candidates.map(candidate => {
		const document = documents.get(candidate.documentId)!;
		const sectionIndex = document.result.sections.findIndex(section => section.sectionId === candidate.sectionId);
		const section = document.result.sections[sectionIndex];
		const documentPages = new Map(document.result.input!.pages.map(page => [page.pageId, page.pageNumber]));
		const bankEvidence = [
			...candidate.amounts.flatMap(amount => (amount.basis === 'account-settlement' ? transaction.accountAmount : transaction.reportedOriginalAmount)!.evidence),
			...candidate.references.flatMap(reference => transaction.references.filter(field => field.label === reference.bankLabel && field.value === reference.bankValue)
				.flatMap(field => field.evidence)),
			...(candidate.date ? transaction.bookingDate.evidence : []),
		];
		const fields = new Set([...candidate.amounts.map(amount => amount.documentFieldId), ...candidate.references.map(reference => reference.documentFieldId)]);
		if (candidate.date) fields.add(candidate.date.documentFieldId);
		const documentEvidence = [...section.amounts, ...section.references, ...section.dates].filter(field => fields.has(field.id)).flatMap(field => field.evidence);
		if (candidate.issues.includes('conflicting-evidence')) {
			const roles = new Set(section.amounts.filter(field => fields.has(field.id)).map(field => field.role));
			const referenceRoles = new Set(section.references.filter(field => fields.has(field.id)).map(field => field.role));
			const relatedFields = [...section.amounts.filter(field => roles.has(field.role)), ...section.references.filter(field => referenceRoles.has(field.role)),
				...section.dates.filter(field => field.role === 'issue' || field.role === 'payment'), ...section.currencies.filter(field => field.role === 'settlement'), ...section.merchants];
			const relatedIds = new Set(relatedFields.map(field => field.id));
			documentEvidence.push(...relatedFields.flatMap(field => field.evidence));
			for (const issue of document.result.issues) if (issue.fieldId && relatedIds.has(issue.fieldId)) documentEvidence.push(...issue.evidence);
		}
		return { ...candidate, filePath: document.filePath, sectionKind: section.kind, sectionNumber: document.result.sections.length > 1 ? sectionIndex + 1 : null,
			pages: section.pageIds.map(id => documentPages.get(id)!), bankEvidence: excerpts(bankEvidence, bankPages), documentEvidence: excerpts(documentEvidence, documentPages) };
	}) };
}
