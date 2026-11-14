import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import type { DocumentSection } from './supporting-document.js';
import type { MatchApproval, MatchApprovalSelection, MatchApprovalStatus } from './match-approvals.js';

const fieldId = z.string().min(1).max(128);
const reference = z.string().min(1).max(16384);
const amountEvidence = z.strictObject({
	basis: z.enum(['account-settlement', 'reported-original']),
	transactionAmount: moneySchema,
	documentFieldId: fieldId,
	documentAmount: moneySchema,
});
const referenceEvidence = z.strictObject({
	normalized: reference,
	bankLabel: z.string().min(1).max(80),
	bankValue: reference,
	documentFieldId: fieldId,
	documentValue: reference,
});
const dateEvidence = z.strictObject({
	documentFieldId: fieldId,
	bookingDate: calendarDateSchema,
	documentDate: calendarDateSchema,
	role: z.enum(['payment', 'issue']),
	daysApart: z.number().int().nonnegative(),
	withinWindow: z.boolean(),
});
const matchCandidate = z.strictObject({
	documentId: z.uuid(),
	sectionId: fieldId,
	direction: z.enum(['incoming', 'outgoing']),
	amounts: z.array(amountEvidence).min(1),
	references: z.array(referenceEvidence),
	date: dateEvidence.nullable(),
	issues: z.array(z.enum(['missing-reference', 'conflicting-evidence', 'competing-reference'])).max(3),
}).refine(({ references, issues }) => issues.includes('missing-reference') === (references.length === 0) && new Set(issues).size === issues.length);
export const transactionMatchSchema = z.strictObject({
	transactionId: z.uuid(),
	status: z.enum(['reliable', 'uncertain', 'unmatched']),
	candidates: z.array(matchCandidate),
}).refine(({ status, candidates }) => {
	const reliable = candidates.filter(candidate => !candidate.issues.length);
	return status === 'unmatched' ? !candidates.length : status === 'reliable' ? reliable.length === 1 : candidates.length > 0 && !reliable.length;
});

export type MatchCandidate = z.infer<typeof matchCandidate>;
export type TransactionMatch = z.infer<typeof transactionMatchSchema>;

export const matchReviewSchema = z.discriminatedUnion('status', [
	z.strictObject({ status: z.literal('open') }),
	z.strictObject({ status: z.literal('assigned'), documentId: z.uuid() }),
	z.strictObject({ status: z.literal('completed-without-document') }),
]);
export type MatchReview = z.infer<typeof matchReviewSchema>;
export type MatchReviewCounts = Record<MatchReview['status'], number>;

export interface MatchSummary {
	transactionId: string;
	ignored: boolean;
	ignoredByRule: boolean;
	bookingDate: string;
	description: string;
	accountAmount: z.infer<typeof moneySchema>;
	status: TransactionMatch['status'];
	candidateCount: number;
	bankValuesCorrected: boolean;
	review: MatchReview;
	approvalSelection: MatchApprovalSelection | null;
	approval: MatchApproval | null;
	approvalStatus: MatchApprovalStatus;
}

export interface MatchSourceExcerpt {
	page: number;
	text: string;
	method: 'embedded-text' | 'local-ocr';
	x: number;
	y: number;
}

export interface MatchNameEvidence {
	state: 'match' | 'partial' | 'different' | 'missing';
	bankText: string | null;
	documentText: string | null;
}

export interface ReviewMatchCandidate extends Omit<MatchCandidate, 'issues'> {
	issues: (MatchCandidate['issues'][number] | 'amount-needs-review')[];
	signals: {
		amount: 'equal' | 'close' | 'different' | 'currency-differs' | 'missing';
		merchant: MatchNameEvidence;
		filename: MatchNameEvidence;
		reference: 'match' | 'different' | 'missing';
	};
}

export interface ReviewMatch extends Omit<TransactionMatch, 'candidates'> {
	candidates: ReviewMatchCandidate[];
}

export interface MatchCandidateView extends ReviewMatchCandidate {
	filePath: string;
	sectionKind: DocumentSection['kind'];
	sectionNumber: number | null;
	documentValuesCorrected: boolean;
	pages: number[];
	bankEvidence: MatchSourceExcerpt[];
	documentEvidence: MatchSourceExcerpt[];
}

export interface MatchDetails {
	statementPath: string;
	candidates: MatchCandidateView[];
}
