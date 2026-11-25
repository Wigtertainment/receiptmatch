import { formatMoney } from './display.js';
import { sameMoneyValue, type Money } from './money.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from './supporting-document.js';

type DocumentAmount = DocumentSection['amounts'][number];
type DocumentAmountCandidate = DocumentAmount['candidates'][number];

export const recoveredReceiptTaxPrefix: "recovered-receipt-tax-" = 'recovered-receipt-tax-';

export function formatDocumentTotal({ sections, issues }: SupportingDocument): string | null {
    if (sections.length !== 1) {
        return null;
    }
    const totals: DocumentAmount[] = sections[0].amounts.filter((field: DocumentAmount): boolean => field.role === 'billed-total');
    const first: DocumentAmountCandidate = totals[0]?.candidates[0];
    if (!first?.currency) {
        return null;
    }

    const total: Money = { ...first, currency: first.currency };
    const flagged: Set<string | null> = new Set(issues.filter((issue: DocumentIssue): boolean => issue.code !== 'reconstructed-total').map((issue: DocumentIssue): string | null => issue.fieldId));
    const consistent: boolean = totals.every(({ id, candidates }: DocumentAmount): boolean => {
        const candidate: DocumentAmountCandidate = candidates[0];
        return candidates.length === 1 && !!candidate.currency && !flagged.has(id) &&
            sameMoneyValue(total, { ...candidate, currency: candidate.currency });
    });
    return consistent ? formatMoney(total) : null;
}
