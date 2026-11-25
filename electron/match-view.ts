import type { ImportPage, TransactionCandidate } from "../src/shared/bank-import.js";
import type { MatchApproval, MatchApprovalSelection } from "../src/shared/match-approvals.js";
import type { DocumentSection } from "../src/shared/supporting-document.js";
import type { IMatchCandidateView } from "../src/shared/workspace-matching.js";
import type { IReviewMatchCandidate } from "../src/shared/workspace-matching.js";
import type { MatchApprovalStatus } from "../src/shared/match-approvals.js";
import type { SourceEvidence } from '../src/shared/bank-import.js';
import type { BankCorrection } from '../src/shared/bank-corrections.js';
import type { DocumentCorrection } from '../src/shared/document-corrections.js';
import { approvalSelectionFor, matchApprovalStatus, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { DocumentFileResult, StoredDocumentImport, StoredSupportingDocument } from '../src/shared/workspace-documents.js';
import type { IMatchDetails, IMatchSourceExcerpt, IMatchSummary, IReviewMatch } from '../src/shared/workspace-matching.js';

type StoredTransaction = StoredBankImport['transactions'][number];
type BankSourcePage = NonNullable<StoredBankImport['result']['sourceProvenance']>['pages'][number];
type BankReference = TransactionCandidate['references'][number];
type MatchAmount = IReviewMatchCandidate['amounts'][number];
type MatchReference = IReviewMatchCandidate['references'][number];
type DocumentEntry = readonly [string, StoredSupportingDocument];
type AmountField = DocumentSection['amounts'][number];
type DateField = DocumentSection['dates'][number];
type ReferenceField = DocumentSection['references'][number];
type MerchantField = DocumentSection['merchants'][number];
type CurrencyField = DocumentSection['currencies'][number];
type DocumentEvidenceField = AmountField | DateField | ReferenceField;
type RelatedDocumentField = DocumentEvidenceField | MerchantField | CurrencyField;

export function summarizeMatches(
	matches: IReviewMatch[], imports: StoredBankImport[], decisions: ReadonlyMap<string, string | null>, corrections: ReadonlyMap<string, BankCorrection>,
	reviewApprovals: ReadonlyMap<string, ReviewApprovalState>, documentRevisions: ReadonlyMap<string, number>, ignoredTransactions: ReadonlySet<string>,
	ignoredByRule: ReadonlySet<string> = new Set(),
): IMatchSummary[] {
	const byTransaction: Map<string, IReviewMatch> = new Map(matches.map((match: IReviewMatch): [string, IReviewMatch] => [match.transactionId, match]));
	return imports.flatMap((record: StoredBankImport): IMatchSummary[] => {
		const ids: Map<string, string> = new Map(record.transactions.map(({ rowId, transactionId }: StoredTransaction): [string, string] => [rowId, transactionId]));
		return record.result.transactions.map((row: TransactionCandidate): IMatchSummary => {
			const transactionId: string = ids.get(row.rowId)!;
			const match: IReviewMatch | undefined = byTransaction.get(transactionId);
			const ignored: boolean = ignoredTransactions.has(transactionId);
			const documentId: string | null | undefined = decisions.get(transactionId);
			const reviewApproval: ReviewApprovalState | undefined = reviewApprovals.get(transactionId);
			const approvalSelection: MatchApprovalSelection | null = documentId && !ignored ?
				approvalSelectionFor(transactionId, documentId, corrections.get(transactionId)?.revision, documentRevisions.get(documentId), reviewApproval?.associationRevision) : null;
			const approval: MatchApproval | null = ignored ? null : reviewApproval?.approval ?? null;
			const approvalStatus: MatchApprovalStatus = matchApprovalStatus(approval, approvalSelection);
			return { transactionId, bookingDate: row.bookingDate.value, description: row.description.value,
				accountAmount: row.accountAmount.value, ignored, ignoredByRule: ignoredByRule.has(transactionId), status: match?.status ?? 'unmatched', candidateCount: match?.candidates.length ?? 0, bankValuesCorrected: corrections.has(transactionId),
				approvalSelection, approvalStatus, approval: approvalStatus.status === 'approved' ? approval : null,
				review: documentId === undefined ? { status: 'open' } : documentId === null ? { status: 'completed-without-document' } : { status: 'assigned', documentId } };
		});
	});
}

function excerpts(evidence: SourceEvidence[], pages: ReadonlyMap<string, number>): IMatchSourceExcerpt[] {
	const result: Map<string, IMatchSourceExcerpt> = new Map<string, IMatchSourceExcerpt>();
	for (const item of evidence) {
		const page: number | undefined = pages.get(item.pageId);
		if (page === undefined) {
			continue;
		}
		const { x, y }: SourceEvidence['region'] = item.region;
		result.set(JSON.stringify([page, x, y, item.method, item.rawText]), { page, x, y, method: item.method, text: item.rawText });
	}
	return [...result.values()].sort((left: IMatchSourceExcerpt, right: IMatchSourceExcerpt): number => left.page - right.page || left.y - right.y || left.x - right.x);
}

export function describeMatch(
	match: IReviewMatch, imports: StoredBankImport[], documentImports: StoredDocumentImport[], corrections: ReadonlyMap<string, DocumentCorrection>,
): IMatchDetails {
	const bank: StoredBankImport = imports.find((record: StoredBankImport): boolean =>
		record.transactions.some((row: StoredTransaction): boolean => row.transactionId === match.transactionId))!;
	const rowId: string = bank.transactions.find((row: StoredTransaction): boolean => row.transactionId === match.transactionId)!.rowId;
	const transaction: TransactionCandidate = bank.result.transactions.find((row: TransactionCandidate): boolean => row.rowId === rowId)!;
	const bankPages: Map<string, number> = new Map(bank.result.sourceProvenance!.pages.map((page: BankSourcePage): [string, number] => [page.pageId, page.pageNumber]));
	const documents: Map<string, StoredSupportingDocument> = new Map(documentImports.flatMap((record: StoredDocumentImport): DocumentEntry[] =>
		record.files.flatMap((file: DocumentFileResult): [] | [DocumentEntry] => file.status === 'imported' ? [[file.record.id, file.record] as const] : [])));
	const correctedSections: Set<string> = new Set([...corrections.values()].map(({ documentId, sectionId }: DocumentCorrection): string => JSON.stringify([documentId, sectionId])));
	const candidates: IMatchDetails['candidates'] = match.candidates.map((candidate: IReviewMatchCandidate): IMatchCandidateView => {
		const document: StoredSupportingDocument = documents.get(candidate.documentId)!;
		const sectionIndex: number = document.result.sections.findIndex((section: DocumentSection): boolean => section.sectionId === candidate.sectionId);
		const section: DocumentSection = document.result.sections[sectionIndex];
		const pages: ImportPage[] = document.result.input!.pages;
		const documentPages: Map<string, number> = new Map(pages.map((page: ImportPage): [string, number] => [page.pageId, page.pageNumber]));
		const bankEvidence: SourceEvidence[] = [
			...candidate.amounts.flatMap((amount: MatchAmount): SourceEvidence[] =>
				(amount.basis === 'account-settlement' ? transaction.accountAmount : transaction.reportedOriginalAmount)!.evidence),
			...candidate.references.flatMap((reference: MatchReference): SourceEvidence[] => transaction.references
				.filter((field: BankReference): boolean => field.label === reference.bankLabel && field.value === reference.bankValue)
				.flatMap((field: BankReference): SourceEvidence[] => field.evidence)),
			...(candidate.date ? transaction.bookingDate.evidence : []),
			...[transaction.counterpartyCandidate, transaction.description].flatMap((field: TransactionCandidate['description'] | null): SourceEvidence[] => field &&
				[candidate.signals.merchant.bankText, candidate.signals.filename.bankText].includes(field.value) ? field.evidence : []),
		];
		const fields: Set<string> = new Set([
			...candidate.amounts.map((amount: MatchAmount): string => amount.documentFieldId),
			...candidate.references.map((reference: MatchReference): string => reference.documentFieldId),
		]);
		if (candidate.date) {
			fields.add(candidate.date.documentFieldId);
		}
		const documentEvidence: SourceEvidence[] = [...section.amounts, ...section.references, ...section.dates]
			.filter((field: DocumentEvidenceField): boolean => fields.has(field.id)).flatMap((field: DocumentEvidenceField): SourceEvidence[] => field.evidence);
		documentEvidence.push(...section.merchants.filter((field: MerchantField): boolean => field.candidates.includes(candidate.signals.merchant.documentText ?? ''))
			.flatMap((field: MerchantField): SourceEvidence[] => field.evidence));
		if (candidate.issues.includes('conflicting-evidence')) {
			const roles: Set<AmountField['role']> = new Set(section.amounts.filter((field: AmountField): boolean => fields.has(field.id))
				.map((field: AmountField): AmountField['role'] => field.role));
			const referenceRoles: Set<ReferenceField['role']> = new Set(section.references.filter((field: ReferenceField): boolean => fields.has(field.id))
				.map((field: ReferenceField): ReferenceField['role'] => field.role));
			const relatedFields: RelatedDocumentField[] = [
				...section.amounts.filter((field: AmountField): boolean => roles.has(field.role)),
				...section.references.filter((field: ReferenceField): boolean => referenceRoles.has(field.role)),
				...section.dates.filter((field: DateField): boolean => field.role === 'issue' || field.role === 'payment'),
				...section.currencies.filter((field: CurrencyField): boolean => field.role === 'settlement'),
				...section.merchants,
			];
			const relatedIds: Set<string> = new Set(relatedFields.map((field: RelatedDocumentField): string => field.id));
			documentEvidence.push(...relatedFields.flatMap((field: RelatedDocumentField): SourceEvidence[] => field.evidence));
			for (const issue of document.result.issues) {
				if (issue.fieldId && relatedIds.has(issue.fieldId)) {
					documentEvidence.push(...issue.evidence);
				}
			}
		}
		return { ...candidate, filePath: document.filePath,
			sectionKind: section.kind, sectionNumber: document.result.sections.length > 1 ? sectionIndex + 1 : null,
			documentValuesCorrected: correctedSections.has(JSON.stringify([candidate.documentId, candidate.sectionId])),
			pages: section.pageIds.map((id: string): number => documentPages.get(id)!), bankEvidence: excerpts(bankEvidence, bankPages), documentEvidence: excerpts(documentEvidence, documentPages) };
	});
	return { statementPath: bank.filePath, candidates };
}
