import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import type { DocumentSection } from './supporting-document.js';
import type { MatchApproval, MatchApprovalSelection, MatchApprovalStatus } from './match-approvals.js';

interface IAmountEvidenceShape {
	basis: z.ZodEnum<z.core.util.ToEnum<'account-settlement' | 'reported-original'>>;
	transactionAmount: typeof moneySchema;
	documentFieldId: z.ZodString;
	documentAmount: typeof moneySchema;
}

interface IReferenceEvidenceShape {
	normalized: z.ZodString;
	bankLabel: z.ZodString;
	bankValue: z.ZodString;
	documentFieldId: z.ZodString;
	documentValue: z.ZodString;
}

interface IDateEvidenceShape {
	documentFieldId: z.ZodString;
	bookingDate: z.ZodISODate;
	documentDate: z.ZodISODate;
	role: z.ZodEnum<z.core.util.ToEnum<'payment' | 'issue'>>;
	daysApart: z.ZodNumber;
	withinWindow: z.ZodBoolean;
}

type MatchCandidateIssue = 'missing-reference' | 'conflicting-evidence' | 'competing-reference';

interface IMatchCandidateShape {
	documentId: z.ZodUUID;
	sectionId: z.ZodString;
	direction: z.ZodEnum<z.core.util.ToEnum<'incoming' | 'outgoing'>>;
	amounts: z.ZodArray<typeof amountEvidence>;
	references: z.ZodArray<typeof referenceEvidence>;
	date: z.ZodNullable<typeof dateEvidence>;
	issues: z.ZodArray<z.ZodEnum<z.core.util.ToEnum<MatchCandidateIssue>>>;
}

interface ITransactionMatchShape {
	transactionId: z.ZodUUID;
	status: z.ZodEnum<z.core.util.ToEnum<'reliable' | 'uncertain' | 'unmatched'>>;
	candidates: z.ZodArray<typeof matchCandidate>;
}

const fieldId: z.ZodString = z.string().min(1).max(128);
const reference: z.ZodString = z.string().min(1).max(16384);
const amountEvidence: z.ZodObject<z.core.util.Flatten<IAmountEvidenceShape>, z.core.$strict> = z.strictObject({
	basis: z.enum(['account-settlement', 'reported-original']),
	transactionAmount: moneySchema,
	documentFieldId: fieldId,
	documentAmount: moneySchema,
});
const referenceEvidence: z.ZodObject<z.core.util.Flatten<IReferenceEvidenceShape>, z.core.$strict> = z.strictObject({
	normalized: reference,
	bankLabel: z.string().min(1).max(80),
	bankValue: reference,
	documentFieldId: fieldId,
	documentValue: reference,
});
const dateEvidence: z.ZodObject<z.core.util.Flatten<IDateEvidenceShape>, z.core.$strict> = z.strictObject({
	documentFieldId: fieldId,
	bookingDate: calendarDateSchema,
	documentDate: calendarDateSchema,
	role: z.enum(['payment', 'issue']),
	daysApart: z.number().int().nonnegative(),
	withinWindow: z.boolean(),
});
const matchCandidate: z.ZodObject<z.core.util.Flatten<IMatchCandidateShape>, z.core.$strict> = z.strictObject({
	documentId: z.uuid(),
	sectionId: fieldId,
	direction: z.enum(['incoming', 'outgoing']),
	amounts: z.array(amountEvidence).min(1),
	references: z.array(referenceEvidence),
	date: dateEvidence.nullable(),
	issues: z.array(z.enum(['missing-reference', 'conflicting-evidence', 'competing-reference'])).max(3),
}).refine(({ references, issues }: MatchCandidate): boolean => issues.includes('missing-reference') === (references.length === 0) && new Set(issues).size === issues.length);
export const transactionMatchSchema: z.ZodObject<z.core.util.Flatten<ITransactionMatchShape>, z.core.$strict> = z.strictObject({
	transactionId: z.uuid(),
	status: z.enum(['reliable', 'uncertain', 'unmatched']),
	candidates: z.array(matchCandidate),
}).refine(({ status, candidates }: TransactionMatch): boolean => {
	const reliable: MatchCandidate[] = candidates.filter((candidate: MatchCandidate): boolean => !candidate.issues.length);
	return status === 'unmatched' ? !candidates.length : status === 'reliable' ? reliable.length === 1 : candidates.length > 0 && !reliable.length;
});

export type MatchCandidate = z.infer<typeof matchCandidate>;
export type TransactionMatch = z.infer<typeof transactionMatchSchema>;

interface IAssignedMatchReviewShape { status: z.ZodLiteral<'assigned'>; documentId: z.ZodUUID }

type MatchReviewSchemas = [
	z.ZodObject<Record<'status', z.ZodLiteral<'open'>>, z.core.$strict>,
	z.ZodObject<z.core.util.Flatten<IAssignedMatchReviewShape>, z.core.$strict>,
	z.ZodObject<Record<'status', z.ZodLiteral<'completed-without-document'>>, z.core.$strict>,
];

export const matchReviewSchema: z.ZodDiscriminatedUnion<MatchReviewSchemas, 'status'> = z.discriminatedUnion('status', [
	z.strictObject({ status: z.literal('open') }),
	z.strictObject({ status: z.literal('assigned'), documentId: z.uuid() }),
	z.strictObject({ status: z.literal('completed-without-document') }),
]);
export type MatchReview = z.infer<typeof matchReviewSchema>;
export type MatchReviewCounts = Record<MatchReview['status'], number>;

export interface IMatchSummary {
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

export interface IMatchSourceExcerpt {
	page: number;
	text: string;
	method: 'embedded-text' | 'local-ocr';
	x: number;
	y: number;
}

export interface IMatchNameEvidence {
	state: 'match' | 'partial' | 'different' | 'missing';
	bankText: string | null;
	documentText: string | null;
}

interface IMatchSignals {
	amount: 'equal' | 'close' | 'different' | 'currency-differs' | 'missing';
	merchant: IMatchNameEvidence;
	filename: IMatchNameEvidence;
	reference: 'match' | 'different' | 'missing';
}

export interface IReviewMatchCandidate extends Omit<MatchCandidate, 'issues'> {
	issues: (MatchCandidate['issues'][number] | 'amount-needs-review')[];
	signals: IMatchSignals;
}

export interface IReviewMatch extends Omit<TransactionMatch, 'candidates'> {
	candidates: IReviewMatchCandidate[];
}

export interface IMatchCandidateView extends IReviewMatchCandidate {
	filePath: string;
	sectionKind: DocumentSection['kind'];
	sectionNumber: number | null;
	documentValuesCorrected: boolean;
	pages: number[];
	bankEvidence: IMatchSourceExcerpt[];
	documentEvidence: IMatchSourceExcerpt[];
}

export interface IMatchDetails {
	statementPath: string;
	candidates: IMatchCandidateView[];
}
