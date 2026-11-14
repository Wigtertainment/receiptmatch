import type { SourceEvidence } from "./bank-import.js";
import type { DocumentIssue } from "./supporting-document.js";
import { formatMoney } from './display.js';
import { sameMoneyValue } from './money.js';
import type { SupportingDocument } from './supporting-document.js';

export const recoveredReceiptTaxPrefix: "recovered-receipt-tax-" = 'recovered-receipt-tax-';

export function formatDocumentTotal({ sections, issues }: SupportingDocument): string | null {
    if (sections.length !== 1) {
        return null;
    }
    const totals: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] = sections[0].amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total');
    const first: { coefficient: string; scale: number; currency: string | null; } = totals[0]?.candidates[0];
    if (!first?.currency) {
        return null;
    }

    const total: { currency: string; coefficient: string; scale: number; } = { ...first, currency: first.currency };
    const flagged: Set<string | null> = new Set(issues.filter((issue: DocumentIssue): boolean => issue.code !== 'reconstructed-total').map((issue: DocumentIssue): string | null => issue.fieldId));
    const consistent: boolean = totals.every(({ id, candidates }: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => {
        const candidate: { coefficient: string; scale: number; currency: string | null; } = candidates[0];
        return candidates.length === 1 && !!candidate.currency && !flagged.has(id) &&
            sameMoneyValue(total, { ...candidate, currency: candidate.currency });
    });
    return consistent ? formatMoney(total) : null;
}
