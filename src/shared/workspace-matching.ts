import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import type { DocumentSection } from './supporting-document.js';
import type { MatchApproval, MatchApprovalSelection, MatchApprovalStatus } from './match-approvals.js';

const fieldId: z.ZodString = z.string().min(1).max(128);
const reference: z.ZodString = z.string().min(1).max(16384);
const amountEvidence: z.ZodObject<{ basis: z.ZodEnum<{ "account-settlement": "account-settlement"; "reported-original": "reported-original"; }>; transactionAmount: z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict>; documentFieldId: z.ZodString; documentAmount: z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict>; }, z.core.$strict> = z.strictObject({
	basis: z.enum(['account-settlement', 'reported-original']),
	transactionAmount: moneySchema,
	documentFieldId: fieldId,
	documentAmount: moneySchema,
});
const referenceEvidence: z.ZodObject<{ normalized: z.ZodString; bankLabel: z.ZodString; bankValue: z.ZodString; documentFieldId: z.ZodString; documentValue: z.ZodString; }, z.core.$strict> = z.strictObject({
	normalized: reference,
	bankLabel: z.string().min(1).max(80),
	bankValue: reference,
	documentFieldId: fieldId,
	documentValue: reference,
});
const dateEvidence: z.ZodObject<{ documentFieldId: z.ZodString; bookingDate: z.ZodISODate; documentDate: z.ZodISODate; role: z.ZodEnum<{ payment: "payment"; issue: "issue"; }>; daysApart: z.ZodNumber; withinWindow: z.ZodBoolean; }, z.core.$strict> = z.strictObject({
	documentFieldId: fieldId,
	bookingDate: calendarDateSchema,
	documentDate: calendarDateSchema,
	role: z.enum(['payment', 'issue']),
	daysApart: z.number().int().nonnegative(),
	withinWindow: z.boolean(),
});
const matchCandidate: z.ZodObject<{ documentId: z.ZodUUID; sectionId: z.ZodString; direction: z.ZodEnum<{ incoming: "incoming"; outgoing: "outgoing"; }>; amounts: z.ZodArray<typeof amountEvidence>; references: z.ZodArray<typeof referenceEvidence>; date: z.ZodNullable<typeof dateEvidence>; issues: z.ZodArray<z.ZodEnum<{ "missing-reference": "missing-reference"; "conflicting-evidence": "conflicting-evidence"; "competing-reference": "competing-reference"; }>>; }, z.core.$strict> = z.strictObject({
	documentId: z.uuid(),
	sectionId: fieldId,
	direction: z.enum(['incoming', 'outgoing']),
	amounts: z.array(amountEvidence).min(1),
	references: z.array(referenceEvidence),
	date: dateEvidence.nullable(),
	issues: z.array(z.enum(['missing-reference', 'conflicting-evidence', 'competing-reference'])).max(3),
}).refine(({ references, issues }: { documentId: string; sectionId: string; direction: "incoming" | "outgoing"; amounts: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }[]; references: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }[]; date: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null; issues: ("missing-reference" | "conflicting-evidence" | "competing-reference")[]; }): boolean => issues.includes('missing-reference') === (references.length === 0) && new Set(issues).size === issues.length);
export const transactionMatchSchema: z.ZodObject<{ transactionId: z.ZodUUID; status: z.ZodEnum<{ reliable: "reliable"; uncertain: "uncertain"; unmatched: "unmatched"; }>; candidates: z.ZodArray<typeof matchCandidate>; }, z.core.$strict> = z.strictObject({
	transactionId: z.uuid(),
	status: z.enum(['reliable', 'uncertain', 'unmatched']),
	candidates: z.array(matchCandidate),
}).refine(({ status, candidates }: { transactionId: string; status: "reliable" | "uncertain" | "unmatched"; candidates: { documentId: string; sectionId: string; direction: "incoming" | "outgoing"; amounts: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }[]; references: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }[]; date: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null; issues: ("missing-reference" | "conflicting-evidence" | "competing-reference")[]; }[]; }): boolean => {
	const reliable: { documentId: string; sectionId: string; direction: "incoming" | "outgoing"; amounts: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }[]; references: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }[]; date: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null; issues: ("missing-reference" | "conflicting-evidence" | "competing-reference")[]; }[] = candidates.filter((candidate: { documentId: string; sectionId: string; direction: "incoming" | "outgoing"; amounts: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }[]; references: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }[]; date: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null; issues: ("missing-reference" | "conflicting-evidence" | "competing-reference")[]; }): boolean => !candidate.issues.length);
	return status === 'unmatched' ? !candidates.length : status === 'reliable' ? reliable.length === 1 : candidates.length > 0 && !reliable.length;
});

export type MatchCandidate = z.infer<typeof matchCandidate>;
export type TransactionMatch = z.infer<typeof transactionMatchSchema>;

export const matchReviewSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{ status: z.ZodLiteral<"open">; }, z.core.$strict>, z.ZodObject<{ status: z.ZodLiteral<"assigned">; documentId: z.ZodUUID; }, z.core.$strict>, z.ZodObject<{ status: z.ZodLiteral<"completed-without-document">; }, z.core.$strict>], "status"> = z.discriminatedUnion('status', [
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
