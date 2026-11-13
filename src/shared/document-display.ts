import { formatMoney } from './display.js';
import { sameMoneyValue } from './money.js';
import type { SupportingDocument } from './supporting-document.js';

export function formatDocumentTotal({ sections, issues }: SupportingDocument): string | null {
    if (sections.length !== 1) return null;
    const totals = sections[0].amounts.filter(field => field.role === 'billed-total');
    const first = totals[0]?.candidates[0];
    if (!first?.currency) return null;

    const total = { ...first, currency: first.currency };
    const flagged = new Set(issues.filter(issue => issue.code !== 'reconstructed-total').map(issue => issue.fieldId));
    const consistent = totals.every(({ id, candidates }) => {
        const candidate = candidates[0];
        return candidates.length === 1 && !!candidate.currency && !flagged.has(id) &&
            sameMoneyValue(total, { ...candidate, currency: candidate.currency });
    });
    return consistent ? formatMoney(total) : null;
}
