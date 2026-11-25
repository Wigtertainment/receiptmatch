import { isDeepStrictEqual } from 'node:util';
import type { BankImportResult, ImportIssue, SourceEvidence, TransactionCandidate, UnresolvedDraft } from '../../src/shared/bank-import.js';
import type { IStatementAiChange, IStatementAiRow, IStatementAiSummary } from '../../src/shared/statement-ai.js';
import type { StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { prepareStatementAnalysisVersion } from './statement-analyses.js';

export interface IStatementAnalysisPlan { version: StatementAnalysisVersion; changes: IStatementAiChange[]; summary: IStatementAiSummary; conflicts: string[]; blockingConflict?: string }

function identifiedRows(record: StoredBankImport): IStatementAiRow[] {
    const transactions: Map<string, string> = new Map(record.transactions.map((item: StoredBankImport['transactions'][number]): [string, string] => [item.rowId, item.transactionId]));
    const drafts: Map<string, string> = new Map(record.drafts.map((item: StoredBankImport['drafts'][number]): [string, string] => [item.rowId, item.draftId]));
    return [...record.result.transactions.map((row: TransactionCandidate): IStatementAiRow => ({ id: transactions.get(row.rowId)!, kind: 'transaction', row })),
        ...record.result.unresolvedDrafts.map((row: UnresolvedDraft): IStatementAiRow => ({ id: drafts.get(row.rowId)!, kind: 'draft', row }))];
}

function normalizedIssues(issues: ImportIssue[], rowIds?: ReadonlyMap<string, string>): string[] {
    return issues.map((issue: ImportIssue): string => JSON.stringify([issue.code, issue.severity, issue.field, issue.message, issue.pageId,
        rowIds ? issue.rowId && rowIds.get(issue.rowId) : null])).sort();
}

function values(item: IStatementAiRow): unknown[] {
    const row: IStatementAiRow['row'] = item.row;
    return [item.kind, row.accountSectionId, row.bookingDate?.value, row.valueDate?.value, row.accountAmount?.value, row.direction, row.reportedOriginalAmount?.value,
        row.description?.value, row.counterpartyCandidate?.value, row.references.map((field: IStatementAiRow['row']['references'][number]): string[] => [field.label, field.value]),
        'issues' in row ? normalizedIssues(row.issues) : []];
}

function evidenceKeys(item: IStatementAiRow): string[] {
    const keys: string[] = item.row.evidence.filter((evidence: SourceEvidence): boolean => !!evidence.rawText.trim()).map((evidence: SourceEvidence): string =>
        JSON.stringify(['evidence', item.row.accountSectionId, evidence.pageId, evidence.region, evidence.rawText.normalize('NFC').trim().replace(/\s+/g, ' ')]));
    const transactionIds: Set<string> = new Set(item.row.references.filter((field: IStatementAiRow['row']['references'][number]): boolean => /^transaction\s+id$/i.test(field.label.trim()))
        .map((field: IStatementAiRow['row']['references'][number]): string => field.value.trim()).filter(Boolean));
    for (const field of item.row.references) {
        if (transactionIds.size === 1 && /^transaction\s+id$/i.test(field.label.trim()) && field.value.trim() && field.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText.includes(field.value))) {
            keys.push(JSON.stringify(['transaction-id', item.row.accountSectionId, field.value.trim()]));
        }
    }
    return [...new Set(keys)];
}

function indexEvidence(items: IStatementAiRow[]): Map<string, IStatementAiRow[]> {
    const index: Map<string, IStatementAiRow[]> = new Map();
    for (const item of items) {
        for (const key of evidenceKeys(item)) {
            index.set(key, [...index.get(key) ?? [], item]);
        }
    }
    return index;
}

function pairRows(before: IStatementAiRow[], after: IStatementAiRow[]): Map<string, IStatementAiRow> {
    const current: Map<string, IStatementAiRow> = new Map(before.map((item: IStatementAiRow): [string, IStatementAiRow] => [item.id, item]));
    const paired: Map<string, IStatementAiRow> = new Map(after.filter((item: IStatementAiRow): boolean => current.has(item.id)).map((item: IStatementAiRow): [string, IStatementAiRow] => [item.id, item]));
    const beforeEvidence: Map<string, IStatementAiRow[]> = indexEvidence(before);
    const afterEvidence: Map<string, IStatementAiRow[]> = indexEvidence(after);
    const candidates: Map<string, Set<string>> = new Map();
    const owners: Map<string, Set<string>> = new Map();
    for (const [key, old] of beforeEvidence) {
        const next: IStatementAiRow[] | undefined = afterEvidence.get(key);
        if (old.length !== 1 || next?.length !== 1 || paired.has(old[0].id) || current.has(next[0].id)) {
            continue;
        }
        candidates.set(old[0].id, new Set([...(candidates.get(old[0].id) ?? []), next[0].id]));
        owners.set(next[0].id, new Set([...(owners.get(next[0].id) ?? []), old[0].id]));
    }
    const proposed: Map<string, IStatementAiRow> = new Map(after.map((item: IStatementAiRow): [string, IStatementAiRow] => [item.id, item]));
    for (const [id, matches] of candidates) {
        const next: string = [...matches][0];
        if (matches.size === 1 && owners.get(next)?.size === 1) {
            paired.set(id, proposed.get(next)!);
        }
    }
    return paired;
}

function changeKind(before: IStatementAiRow, after: IStatementAiRow): IStatementAiChange['kind'] {
    if (before.kind !== after.kind) {
        return after.kind === 'transaction' ? 'promoted' : 'demoted';
    }
    return isDeepStrictEqual(values(before), values(after)) ? 'unchanged' : 'changed';
}

export function prepareStatementAnalysis(original: StoredBankImport, current: StoredBankImport, proposed: BankImportResult, protectedIds: ReadonlySet<string> = new Set()): IStatementAnalysisPlan {
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, current, proposed);
    const before: IStatementAiRow[] = identifiedRows(current), after: IStatementAiRow[] = identifiedRows(version.record);
    const pairs: Map<string, IStatementAiRow> = pairRows(before, after);
    const pairedAfter: Set<string> = new Set([...pairs.values()].map((item: IStatementAiRow): string => item.id));
    const beforeIds: Map<string, string> = new Map(before.map((item: IStatementAiRow): [string, string] => [item.row.rowId, item.id]));
    const afterAliases: Map<string, string> = new Map([...pairs].map(([id, item]: [string, IStatementAiRow]): [string, string] => [item.id, id]));
    const afterIds: Map<string, string> = new Map(after.map((item: IStatementAiRow): [string, string] => [item.row.rowId, afterAliases.get(item.id) ?? item.id]));
    const sameIssues: boolean = isDeepStrictEqual(normalizedIssues(current.result.issues, beforeIds), normalizedIssues(version.record.result.issues, afterIds));
    const changes: IStatementAiChange[] = [...before.map((item: IStatementAiRow): IStatementAiChange => {
        const next: IStatementAiRow | undefined = pairs.get(item.id);
        return { kind: next ? changeKind(item, next) : 'removed', before: item, after: next ?? null };
    }), ...after.filter((item: IStatementAiRow): boolean => !pairedAfter.has(item.id)).map((item: IStatementAiRow): IStatementAiChange => ({ kind: 'added', before: null, after: item }))];
    const summary: IStatementAiSummary = { unchanged: 0, added: 0, removed: 0, changed: 0, promoted: 0, demoted: 0,
        beforeTransactions: current.transactions.length, beforeDrafts: current.drafts.length, afterTransactions: version.record.transactions.length, afterDrafts: version.record.drafts.length };
    for (const change of changes) {
        summary[change.kind]++;
    }
    const conflicts: string[] = [];
    if (summary.removed) {
        conflicts.push(`${summary.removed} previously recognized rows are absent from the proposed analysis.`);
    }
    if (summary.changed || summary.demoted) {
        conflicts.push(`${summary.changed + summary.demoted} existing rows have changed values or become unresolved.`);
    }
    if (!sameIssues) {
        conflicts.push('The statement analysis reports different warnings or unresolved source information.');
    }
    const activeIds: Set<string> = new Set(after.map((item: IStatementAiRow): string => item.id));
    const blocked: number = before.filter((item: IStatementAiRow): boolean => protectedIds.has(item.id) && !activeIds.has(item.id)).length;
    const noChanges: boolean = sameIssues && changes.every((change: IStatementAiChange): boolean => change.kind === 'unchanged');
    const blockingConflict: string | undefined = blocked ? `${blocked} protected bank rows would change or disappear. Existing corrections and review decisions must be preserved.` :
        noChanges ? 'The proposed statement analysis contains no verified changes.' : undefined;
    return { version, changes, summary, conflicts, ...(blockingConflict ? { blockingConflict } : {}) };
}
