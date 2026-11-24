import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { bankImportResultSchema, type BankImportResult, type TransactionCandidate, type UnresolvedDraft } from '../../src/shared/bank-import.js';
import { applyBankCorrections, type BankCorrection } from '../../src/shared/bank-corrections.js';
import { statementAnalysisVersionSchema, type StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';

type Row = TransactionCandidate | UnresolvedDraft;
interface IdentifiedRow { row: Row; id: string; kind: 'transaction' | 'draft' }

function rows(record: StoredBankImport): IdentifiedRow[] {
    const transactions: Map<string, string> = new Map(record.transactions.map((item: StoredBankImport['transactions'][number]): [string, string] => [item.rowId, item.transactionId]));
    const drafts: Map<string, string> = new Map(record.drafts.map((item: StoredBankImport['drafts'][number]): [string, string] => [item.rowId, item.draftId]));
    return [...record.result.transactions.map((row: TransactionCandidate): IdentifiedRow => ({ row, id: transactions.get(row.rowId)!, kind: 'transaction' })),
        ...record.result.unresolvedDrafts.map((row: UnresolvedDraft): IdentifiedRow => ({ row, id: drafts.get(row.rowId)!, kind: 'draft' }))];
}

function rowSignature({ row, kind }: IdentifiedRow): string {
    return JSON.stringify([kind, row.accountSectionId, row.bookingDate?.value, row.valueDate?.value, row.accountAmount?.value, row.direction,
        row.reportedOriginalAmount?.value, row.description?.value, row.counterpartyCandidate?.value,
        row.references.map((reference: Row['references'][number]): string[] => [reference.label, reference.value]),
        'issues' in row ? row.issues.map((issue: UnresolvedDraft['issues'][number]): (string | null)[] => [issue.code, issue.severity, issue.field]) : []]);
}

function reusableRows(current: StoredBankImport, proposed: StoredBankImport): Map<string, string> {
    const before: Map<string, IdentifiedRow[]> = new Map();
    const after: Map<string, IdentifiedRow[]> = new Map();
    for (const [record, index] of [[current, before], [proposed, after]] as const) {
        for (const item of rows(record)) {
            const signature: string = rowSignature(item);
            index.set(signature, [...index.get(signature) ?? [], item]);
        }
    }
    const reusable: Map<string, string> = new Map();
    for (const [signature, candidates] of after) {
        const previous: IdentifiedRow[] | undefined = before.get(signature);
        if (previous?.length === 1 && candidates.length === 1) {
            reusable.set(candidates[0].row.rowId, previous[0].id);
        }
    }
    return reusable;
}

function sameOriginal(original: StoredBankImport, record: StoredBankImport): boolean {
    const originalSource: NonNullable<BankImportResult['sourceProvenance']> = original.result.sourceProvenance!;
    const source: NonNullable<BankImportResult['sourceProvenance']> = record.result.sourceProvenance!;
    return original.id === record.id && original.importedAt === record.importedAt && original.filePath === record.filePath &&
        isDeepStrictEqual(original.accounts, record.accounts) && isDeepStrictEqual(original.result.accountSections, record.result.accountSections) &&
        originalSource.sourceId === source.sourceId && originalSource.sha256 === source.sha256 && isDeepStrictEqual(originalSource.pages, source.pages);
}

function canonicalResult(original: StoredBankImport, proposed: BankImportResult): BankImportResult {
    const sections: Map<string, string> = new Map();
    const used: Set<string> = new Set();
    for (const section of proposed.accountSections) {
        const matches: BankImportResult['accountSections'] = original.result.accountSections.filter((candidate: BankImportResult['accountSections'][number]): boolean =>
            candidate.currency.value === section.currency.value && (!section.accountReference || (candidate.accountReference?.label === section.accountReference.label && candidate.accountReference.value === section.accountReference.value)));
        if (matches.length !== 1 || used.has(matches[0].sectionId)) {
            throw new Error('The statement analysis cannot establish an unambiguous original account mapping.');
        }
        sections.set(section.sectionId, matches[0].sectionId);
        used.add(matches[0].sectionId);
    }
    if (used.size !== original.accounts.length) {
        throw new Error('The statement analysis cannot remove or add statement accounts.');
    }
    const remap: <T extends Row>(row: T) => T = <T extends Row>(row: T): T => ({ ...row, accountSectionId: sections.get(row.accountSectionId)! });
    return { ...proposed, accountSections: original.result.accountSections, transactions: proposed.transactions.map(remap), unresolvedDrafts: proposed.unresolvedDrafts.map(remap) };
}

export function prepareStatementAnalysisVersion(original: StoredBankImport, current: StoredBankImport, proposed: BankImportResult): StatementAnalysisVersion {
    original = storedBankImportSchema.parse(original);
    current = storedBankImportSchema.parse(current);
    if (!sameOriginal(original, current)) {
        throw new Error('The current statement analysis does not belong to its original import.');
    }
    const result: BankImportResult = canonicalResult(original, bankImportResultSchema.parse(proposed));
    const provisional: StoredBankImport = { ...original, result,
        transactions: result.transactions.map((row: TransactionCandidate): StoredBankImport['transactions'][number] => ({ rowId: row.rowId, transactionId: randomUUID() })),
        drafts: result.unresolvedDrafts.map((row: UnresolvedDraft): StoredBankImport['drafts'][number] => ({ rowId: row.rowId, draftId: randomUUID() })) };
    const reusable: Map<string, string> = reusableRows(current, provisional);
    const record: StoredBankImport = { ...provisional,
        transactions: provisional.transactions.map((item: StoredBankImport['transactions'][number]): StoredBankImport['transactions'][number] => ({ ...item, transactionId: reusable.get(item.rowId) ?? item.transactionId })),
        drafts: provisional.drafts.map((item: StoredBankImport['drafts'][number]): StoredBankImport['drafts'][number] => ({ ...item, draftId: reusable.get(item.rowId) ?? item.draftId })) };
    const version: StatementAnalysisVersion = statementAnalysisVersionSchema.parse({ importId: original.id, acceptedAt: new Date().toISOString(), record });
    if (!sameOriginal(original, version.record)) {
        throw new Error('The statement analysis does not match its original source.');
    }
    return version;
}

export function projectStatementAnalyses(imports: StoredBankImport[], versions: readonly StatementAnalysisVersion[]): StoredBankImport[] {
    const latest: Map<string, StoredBankImport> = new Map(imports.map((record: StoredBankImport): [string, StoredBankImport] => [record.id, record]));
    const originals: Map<string, StoredBankImport> = new Map(latest);
    const seen: Set<string> = new Set(imports.flatMap((record: StoredBankImport): string[] => [record.id, record.result.sourceProvenance!.sourceId,
        ...record.accounts.flatMap((account: StoredBankImport['accounts'][number]): string[] => [account.accountId, account.statementId]), ...rows(record).map((item: IdentifiedRow): string => item.id)]).map((id: string): string => id.toLowerCase()));
    for (const version of z.array(statementAnalysisVersionSchema).max(1000).parse(versions)) {
        const original: StoredBankImport | undefined = originals.get(version.importId);
        const current: StoredBankImport | undefined = latest.get(version.importId);
        if (!original || !current || !sameOriginal(original, version.record)) {
            throw new Error('A statement analysis version does not match its original import.');
        }
        const reusable: Map<string, string> = reusableRows(current, version.record);
        for (const item of rows(version.record)) {
            const expected: string | undefined = reusable.get(item.row.rowId);
            if ((expected && item.id !== expected) || (!expected && seen.has(item.id.toLowerCase()))) {
                throw new Error('A statement analysis reuses or changes an incompatible historical row identity.');
            }
            seen.add(item.id.toLowerCase());
        }
        latest.set(version.importId, version.record);
    }
    return imports.map((record: StoredBankImport): StoredBankImport => latest.get(record.id)!);
}

export function projectCorrectedStatementAnalyses(imports: StoredBankImport[], versions: readonly StatementAnalysisVersion[], corrections: ReadonlyMap<string, BankCorrection>): StoredBankImport[] {
    const history: StoredBankImport[] = [...imports, ...versions.map((version: StatementAnalysisVersion): StoredBankImport => version.record)];
    const known: Set<string> = new Set();
    for (const record of history) {
        const applicable: Map<string, BankCorrection> = new Map(rows(record).flatMap((item: IdentifiedRow): [string, BankCorrection][] => {
            const correction: BankCorrection | undefined = corrections.get(item.id);
            if (!correction) {
                return [];
            }
            known.add(item.id);
            return [[item.id, correction]];
        }));
        applyBankCorrections([record], applicable);
    }
    if ([...corrections.keys()].some((id: string): boolean => !known.has(id))) {
        throw new Error('A correction refers to a bank row outside the statement history.');
    }
    const active: StoredBankImport[] = projectStatementAnalyses(imports, versions);
    const activeIds: Set<string> = new Set(active.flatMap((record: StoredBankImport): string[] => rows(record).map((item: IdentifiedRow): string => item.id)));
    return applyBankCorrections(active, new Map([...corrections].filter(([id]: [string, BankCorrection]): boolean => activeIds.has(id))));
}

export function historicalStatementImports(imports: StoredBankImport[], versions: readonly StatementAnalysisVersion[], corrections: ReadonlyMap<string, BankCorrection>): StoredBankImport[] {
    projectCorrectedStatementAnalyses(imports, versions, corrections);
    return imports.map((original: StoredBankImport): StoredBankImport => {
        const all: Map<string, IdentifiedRow> = new Map();
        for (const record of [original, ...versions.filter((version: StatementAnalysisVersion): boolean => version.importId === original.id).map((version: StatementAnalysisVersion): StoredBankImport => version.record)]) {
            const applicable: Map<string, BankCorrection> = new Map(rows(record).flatMap((item: IdentifiedRow): [string, BankCorrection][] => corrections.has(item.id) ? [[item.id, corrections.get(item.id)!]] : []));
            for (const item of rows(applyBankCorrections([record], applicable)[0])) {
                all.set(item.id, { ...item, row: { ...item.row, rowId: item.id } });
            }
        }
        const values: IdentifiedRow[] = [...all.values()];
        return { ...original, result: { ...original.result, transactions: values.filter((item: IdentifiedRow): boolean => item.kind === 'transaction').map((item: IdentifiedRow): TransactionCandidate => item.row as TransactionCandidate),
            unresolvedDrafts: values.filter((item: IdentifiedRow): boolean => item.kind === 'draft').map((item: IdentifiedRow): UnresolvedDraft => item.row as UnresolvedDraft) },
            transactions: values.filter((item: IdentifiedRow): boolean => item.kind === 'transaction').map((item: IdentifiedRow): StoredBankImport['transactions'][number] => ({ rowId: item.id, transactionId: item.id })),
            drafts: values.filter((item: IdentifiedRow): boolean => item.kind === 'draft').map((item: IdentifiedRow): StoredBankImport['drafts'][number] => ({ rowId: item.id, draftId: item.id })) };
    });
}
