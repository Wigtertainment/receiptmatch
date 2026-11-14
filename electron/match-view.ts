import type { ImportIssue, ImportPage, TransactionCandidate } from "../src/shared/bank-import.js";
import type { MatchApproval, MatchApprovalSelection } from "../src/shared/match-approvals.js";
import type { StoredSupportingDocument } from "../src/shared/workspace-documents.js";
import type { DocumentSection, SupportingDocument } from "../src/shared/supporting-document.js";
import type { MatchCandidateView } from "../src/shared/workspace-matching.js";
import type { ReviewMatchCandidate } from "../src/shared/workspace-matching.js";
import type { MatchApprovalStatus } from "../src/shared/match-approvals.js";
import type { SourceEvidence } from '../src/shared/bank-import.js';
import type { BankCorrection } from '../src/shared/bank-corrections.js';
import type { DocumentCorrection } from '../src/shared/document-corrections.js';
import { approvalSelectionFor, matchApprovalStatus, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchSourceExcerpt, MatchSummary, ReviewMatch } from '../src/shared/workspace-matching.js';

export function summarizeMatches(
	matches: ReviewMatch[], imports: StoredBankImport[], decisions: ReadonlyMap<string, string | null>, corrections: ReadonlyMap<string, BankCorrection>,
	reviewApprovals: ReadonlyMap<string, ReviewApprovalState>, documentRevisions: ReadonlyMap<string, number>, ignoredTransactions: ReadonlySet<string>,
	ignoredByRule: ReadonlySet<string> = new Set(),
): MatchSummary[] {
	const byTransaction: Map<string, ReviewMatch> = new Map(matches.map((match: ReviewMatch): [string, ReviewMatch] => [match.transactionId, match]));
	return imports.flatMap((record: StoredBankImport): MatchSummary[] => {
		const ids: Map<string, string> = new Map(record.transactions.map(({ rowId, transactionId }: { rowId: string; transactionId: string; }): [string, string] => [rowId, transactionId]));
		return record.result.transactions.map((row: TransactionCandidate): MatchSummary => {
			const transactionId: string = ids.get(row.rowId)!;
			const match: ReviewMatch | undefined = byTransaction.get(transactionId);
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

function excerpts(evidence: SourceEvidence[], pages: ReadonlyMap<string, number>): MatchSourceExcerpt[] {
	const result: Map<string, MatchSourceExcerpt> = new Map<string, MatchSourceExcerpt>();
	for (const item of evidence) {
		const page: number | undefined = pages.get(item.pageId);
		if (page === undefined) {
			continue;
		}
		const { x, y }: { x: number; y: number; width: number; height: number; } = item.region;
		result.set(JSON.stringify([page, x, y, item.method, item.rawText]), { page, x, y, method: item.method, text: item.rawText });
	}
	return [...result.values()].sort((left: MatchSourceExcerpt, right: MatchSourceExcerpt): number => left.page - right.page || left.y - right.y || left.x - right.x);
}

export function describeMatch(
	match: ReviewMatch, imports: StoredBankImport[], documentImports: StoredDocumentImport[], corrections: ReadonlyMap<string, DocumentCorrection>,
): MatchDetails {
	const bank: StoredBankImport = imports.find((record: StoredBankImport): boolean => record.transactions.some((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === match.transactionId))!;
	const rowId: string = bank.transactions.find((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === match.transactionId)!.rowId;
	const transaction: TransactionCandidate = bank.result.transactions.find((row: TransactionCandidate): boolean => row.rowId === rowId)!;
	const bankPages: Map<string, number> = new Map(bank.result.sourceProvenance!.pages.map((page: { pageId: string; pageNumber: number; width: number; height: number; }): [string, number] => [page.pageId, page.pageNumber]));
	const documents: Map<string, StoredSupportingDocument> = new Map(documentImports.flatMap((record: StoredDocumentImport): (readonly [string, StoredSupportingDocument])[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [] | [readonly [string, StoredSupportingDocument]] => file.status === 'imported' ? [[file.record.id, file.record] as const] : [])));
	const correctedSections: Set<string> = new Set([...corrections.values()].map(({ documentId, sectionId }: DocumentCorrection): string => JSON.stringify([documentId, sectionId])));
	const candidates: MatchDetails['candidates'] = match.candidates.map((candidate: ReviewMatchCandidate): MatchCandidateView => {
		const document: StoredSupportingDocument = documents.get(candidate.documentId)!;
		const sectionIndex: number = document.result.sections.findIndex((section: DocumentSection): boolean => section.sectionId === candidate.sectionId);
		const section: DocumentSection = document.result.sections[sectionIndex];
		const pages: ImportPage[] = document.result.input!.pages;
		const documentPages: Map<string, number> = new Map(pages.map((page: ImportPage): [string, number] => [page.pageId, page.pageNumber]));
		const bankEvidence: SourceEvidence[] = [
			...candidate.amounts.flatMap((amount: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }): SourceEvidence[] => (amount.basis === 'account-settlement' ? transaction.accountAmount : transaction.reportedOriginalAmount)!.evidence),
			...candidate.references.flatMap((reference: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }): SourceEvidence[] => transaction.references.filter((field: { label: string; value: string; evidence: SourceEvidence[]; }): boolean => field.label === reference.bankLabel && field.value === reference.bankValue)
				.flatMap((field: { label: string; value: string; evidence: SourceEvidence[]; }): SourceEvidence[] => field.evidence)),
			...(candidate.date ? transaction.bookingDate.evidence : []),
			...[transaction.counterpartyCandidate, transaction.description].flatMap((field: { value: string; evidence: SourceEvidence[]; } | null): SourceEvidence[] => field &&
				[candidate.signals.merchant.bankText, candidate.signals.filename.bankText].includes(field.value) ? field.evidence : []),
		];
		const fields: Set<string> = new Set([...candidate.amounts.map((amount: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }): string => amount.documentFieldId), ...candidate.references.map((reference: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }): string => reference.documentFieldId)]);
		if (candidate.date) {
			fields.add(candidate.date.documentFieldId);
		}
		const documentEvidence: SourceEvidence[] = [...section.amounts, ...section.references, ...section.dates].filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => fields.has(field.id)).flatMap((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): SourceEvidence[]     => field.evidence);
		documentEvidence.push(...section.merchants.filter((field: { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.candidates.includes(candidate.signals.merchant.documentText ?? '')).flatMap((field: { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): SourceEvidence[] => field.evidence));
		if (candidate.issues.includes('conflicting-evidence')) {
			const roles: Set<"unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"> = new Set(section.amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => fields.has(field.id)).map((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item" => field.role));
			const referenceRoles: Set<"unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"> = new Set(section.references.filter((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => fields.has(field.id)).map((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice" => field.role));
			const relatedFields: ({ role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; })[] = [...section.amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => roles.has(field.role)), ...section.references.filter((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => referenceRoles.has(field.role)),
				...section.dates.filter((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'issue' || field.role === 'payment'), ...section.currencies.filter((field: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'settlement'), ...section.merchants];
			const relatedIds: Set<string> = new Set(relatedFields.map((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string => field.id));
			documentEvidence.push(...relatedFields.flatMap((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): SourceEvidence[]         => field.evidence));
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
