import { applyDocumentFieldCorrections, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import type { ReceiptAiChange } from '../../src/shared/receipt-ai.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../../src/shared/supporting-document.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { documentReferenceFields, moneyKey, normalizeReference, outgoingAmounts } from '../matching.js';
import { compareDocuments } from '../source-comparison.js';
import { SupportingDocumentState } from './document-state.js';
import { hasFullDocumentReference, mergedLegacySections, recordedDocumentPayments } from './interpret.js';

export interface ReceiptVersionPlan {
    analysis: SupportingDocument;
    changes: ReceiptAiChange[];
    conflicts: string[];
    blockingConflict?: string;
    invalidatesApproval: boolean;
}

type AmountField = DocumentSection['amounts'][number];
type DateField = DocumentSection['dates'][number];
type ReadField = DocumentSection['amounts' | 'dates' | 'merchants' | 'references' | 'currencies'][number];
type DocumentPairing = ReturnType<typeof compareDocuments>;
interface IdentifiedField { id: string; role: string }

function fields(section: DocumentSection): ReadField[] {
    return [...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies];
}

function pairedCorrectionField<T extends IdentifiedField>(before: T[], after: T[], id: string, pairedId: string | undefined): T | undefined {
    const exact: T | undefined = after.find((field: T): boolean => field.id === pairedId);
    if (exact) {
        return exact;
    }
    const field: T | undefined = before.find((item: T): boolean => item.id === id);
    if (!field || field.role === 'unknown' || before.filter((item: T): boolean => item.role === field.role).length !== 1) {
        return undefined;
    }
    const sameRole: T[] = after.filter((item: T): boolean => item.role === field.role);
    return sameRole.length === 1 ? sameRole[0] : undefined;
}

function amountCurrencyMatches(field: AmountField, section: DocumentSection, currency: string, exact: boolean): boolean {
    const currencies: Set<string> = new Set(field.candidates.flatMap((candidate: AmountField['candidates'][number]): string[] => candidate.currency ? [candidate.currency] : []));
    if (currencies.size) {
        return currencies.size === 1 && currencies.has(currency);
    }
    const settlement: Set<string> = new Set(section.currencies.filter((item: DocumentSection['currencies'][number]): boolean => item.role === 'settlement')
        .flatMap((item: DocumentSection['currencies'][number]): string[] => item.candidates));
    return settlement.size ? settlement.size === 1 && settlement.has(currency) : exact;
}

function correctedField(correction: DocumentCorrection, before: DocumentSection, after: DocumentSection, pairing: DocumentPairing): string | undefined {
    const id: string = correction.fieldId!;
    const pairedId: string | undefined = pairing.fields.get(id);
    if (correction.change.kind === 'date') {
        return pairedCorrectionField(before.dates, after.dates, id, pairedId)?.id;
    }
    const amount: AmountField | undefined = pairedCorrectionField(before.amounts, after.amounts, id, pairedId);
    return amount && amountCurrencyMatches(amount, after, correction.change.value.currency, amount.id === pairedId) ? amount.id : undefined;
}

function keepCorrectionIds(previous: SupportingDocument, proposed: SupportingDocument, corrections: readonly DocumentCorrection[],
    pairing: DocumentPairing, aliases: Map<string, string>): boolean {
    for (const correction of corrections) {
        const before: DocumentSection | undefined = previous.sections.find((section: DocumentSection): boolean => section.sectionId === correction.sectionId);
        const afterId: string | undefined = pairing.sections.get(correction.sectionId);
        const after: DocumentSection | undefined = proposed.sections.find((section: DocumentSection): boolean => section.sectionId === afterId);
        if (!before || !after) {
            return false;
        }
        if (correction.fieldId !== null) {
            const target: string | undefined = correctedField(correction, before, after, pairing);
            if (!target || (aliases.has(target) && aliases.get(target) !== correction.fieldId)) {
                return false;
            }
            aliases.set(target, correction.fieldId);
        }
    }
    return true;
}

function rekey(proposed: SupportingDocument, aliases: ReadonlyMap<string, string>): SupportingDocument {
    const analysis: SupportingDocument = structuredClone(proposed);
    const reserved: Set<string> = new Set(aliases.values());
    const occupied: Set<string> = new Set([...reserved, ...analysis.sections.flatMap((section: DocumentSection): string[] =>
        [section.sectionId, ...fields(section).map((field: ReadField): string => field.id)])]);
    const keys: Map<string, string> = new Map();
    let sequence: number = 0;
    function key(id: string): string {
        let target: string = aliases.get(id) ?? id;
        if (!aliases.has(id) && reserved.has(id)) {
            do {
                target = `analysis-${++sequence}`;
            } while (occupied.has(target));
            occupied.add(target);
        }
        keys.set(id, target);
        return target;
    }
    for (const section of analysis.sections) {
        section.sectionId = key(section.sectionId);
        for (const field of fields(section)) {
            field.id = key(field.id);
        }
    }
    for (const issue of analysis.issues) {
        issue.sectionId = issue.sectionId === null ? null : keys.get(issue.sectionId)!;
        issue.fieldId = issue.fieldId === null ? null : keys.get(issue.fieldId)!;
    }
    return analysis;
}

function signedAmountKey(value: AmountField['candidates'][number]): string {
    return (value.coefficient.startsWith('-') ? '-' : '+') + moneyKey({ ...value, currency: value.currency ?? '' });
}

function fieldFacts<T extends ReadField>(fields: T[], uncertain: ReadonlySet<string | null>, values: (field: T) => string[]): string[] {
    return fields.map((field: T): string => JSON.stringify([field.role, values(field).sort(), uncertain.has(field.id)])).sort();
}

function matchingSectionFacts(section: DocumentSection, payments: Set<string>, uncertain: ReadonlySet<string | null>, merged: boolean): string {
    const amountValues: (field: AmountField) => string[] = (field: AmountField): string[] => field.candidates.map(signedAmountKey);

    const textValues: (field: ReadField) => string[] = (field: ReadField): string[] => field.candidates.filter((item: unknown): item is string => typeof item === 'string');

    const referenceValues: (field: DocumentSection['references'][number]) => string[] = (field: DocumentSection['references'][number]): string[] =>
        field.candidates.map((value: string): string => JSON.stringify([normalizeReference(value), hasFullDocumentReference(field, value)]));
    return JSON.stringify([
        section.kind, merged,
        fieldFacts(outgoingAmounts(section, payments), uncertain, amountValues),
        fieldFacts(section.amounts.filter((field: AmountField): boolean => field.role === 'refund-payment'), uncertain, amountValues),
        fieldFacts(section.dates.filter((field: DateField): boolean => field.role === 'payment' || field.role === 'issue'), uncertain, textValues),
        fieldFacts(section.merchants, uncertain, textValues),
        fieldFacts(documentReferenceFields(section), uncertain, referenceValues),
        fieldFacts(section.currencies.filter((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement'), uncertain, textValues)
    ]);
}

function matchingFacts(document: SupportingDocument): string {
    const payments: Set<string> = recordedDocumentPayments(document);
    const merged: Set<string> = mergedLegacySections(document);
    const uncertain: ReadonlySet<string | null> = new Set(document.issues.map((issue: DocumentIssue): string | null => issue.fieldId));
    return JSON.stringify(document.sections.map((section: DocumentSection): string => matchingSectionFacts(section, payments, uncertain, merged.has(section.sectionId))).sort());
}

function effectiveWithCorrections(analysis: SupportingDocument, corrections: readonly DocumentCorrection[]): SupportingDocument | undefined {
    try {
        applyDocumentFieldCorrections(analysis, corrections);
        return new SupportingDocumentState(analysis, corrections).effective;
    } catch {
        return undefined;
    }
}

export function prepareReceiptAnalysisVersion(previous: StoredSupportingDocument, proposed: SupportingDocument, corrections: readonly DocumentCorrection[],
    sameAnalysis: boolean = false): ReceiptVersionPlan {
    const applicable: DocumentCorrection[] = corrections.filter((correction: DocumentCorrection): boolean => correction.documentId === previous.id);
    let analysis: SupportingDocument = proposed;
    let mapped: boolean = true;
    if (!sameAnalysis) {
        const pairing: DocumentPairing = compareDocuments(previous, { result: proposed });
        const aliases: Map<string, string> = new Map([...pairing.sections, ...pairing.fields].map(([before, after]: [string, string]): [string, string] => [after, before]));
        mapped = keepCorrectionIds(previous.result, proposed, applicable, pairing, aliases);
        analysis = rekey(proposed, aliases);
    }
    const afterWithCorrections: SupportingDocument | undefined = mapped ? effectiveWithCorrections(analysis, applicable) : undefined;
    const before: SupportingDocument = new SupportingDocumentState(previous.result, applicable).effective;
    const after: SupportingDocument = afterWithCorrections ?? new SupportingDocumentState(analysis).effective;
    const { changes, conflicts }: DocumentPairing = compareDocuments({ result: before }, { result: after });
    const invalidatesApproval: boolean = matchingFacts(before) !== matchingFacts(after);
    if (invalidatesApproval && !changes.some((change: ReceiptAiChange): boolean => change.kind !== 'warnings')) {
        changes.push({ label: 'Matching evidence', before: null, after: 'Evidence used for matching changed.', kind: 'matching' });
    }
    const blockingConflict: string | undefined = afterWithCorrections ? undefined : 'A manual correction cannot be matched unambiguously in the new analysis.';
    return { analysis, changes, conflicts: blockingConflict ? [...conflicts, blockingConflict] : conflicts, blockingConflict, invalidatesApproval };
}
