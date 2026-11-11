import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import type { DocumentSection } from './supporting-document.js';

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

export interface MatchSummary {
	transactionId: string;
	bookingDate: string;
	description: string;
	accountAmount: z.infer<typeof moneySchema>;
	status: TransactionMatch['status'];
	candidateCount: number;
}

export interface MatchSourceExcerpt {
	page: number;
	text: string;
	method: 'embedded-text' | 'local-ocr';
	x: number;
	y: number;
}

export interface MatchCandidateView extends MatchCandidate {
	filePath: string;
	sectionKind: DocumentSection['kind'];
	sectionNumber: number | null;
	pages: number[];
	bankEvidence: MatchSourceExcerpt[];
	documentEvidence: MatchSourceExcerpt[];
}

export interface MatchDetails {
	statementPath: string;
	candidates: MatchCandidateView[];
}
