import { isDeepStrictEqual } from 'node:util';
import type { BankImportResult, ImportIssue, SourceEvidence, TransactionCandidate, UnresolvedDraft } from '../../src/shared/bank-import.js';
import type { StatementAiChange, StatementAiRow, StatementAiSummary } from '../../src/shared/statement-ai.js';
import type { StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { prepareStatementAnalysisVersion } from './statement-analyses.js';

export interface StatementAnalysisPlan { version: StatementAnalysisVersion; changes: StatementAiChange[]; summary: StatementAiSummary; conflicts: string[]; blockingConflict?: string }

function identifiedRows(record: StoredBankImport): StatementAiRow[] {
    const transactions: Map<string, string> = new Map(record.transactions.map((item: StoredBankImport['transactions'][number]): [string, string] => [item.rowId, item.transactionId]));
    const drafts: Map<string, string> = new Map(record.drafts.map((item: StoredBankImport['drafts'][number]): [string, string] => [item.rowId, item.draftId]));
    return [...record.result.transactions.map((row: TransactionCandidate): StatementAiRow => ({ id: transactions.get(row.rowId)!, kind: 'transaction', row })),
        ...record.result.unresolvedDrafts.map((row: UnresolvedDraft): StatementAiRow => ({ id: drafts.get(row.rowId)!, kind: 'draft', row }))];
}

function normalizedIssues(issues: ImportIssue[], rowIds?: ReadonlyMap<string, string>): string[] {
    return issues.map((issue: ImportIssue): string => JSON.stringify([issue.code, issue.severity, issue.field, issue.message, issue.pageId,
        rowIds ? issue.rowId && rowIds.get(issue.rowId) : null])).sort();
}

function values(item: StatementAiRow): unknown[] {
    const row: StatementAiRow['row'] = item.row;
    return [item.kind, row.accountSectionId, row.bookingDate?.value, row.valueDate?.value, row.accountAmount?.value, row.direction, row.reportedOriginalAmount?.value,
        row.description?.value, row.counterpartyCandidate?.value, row.references.map((field: StatementAiRow['row']['references'][number]): string[] => [field.label, field.value]),
        'issues' in row ? normalizedIssues(row.issues) : []];
}

function evidenceKeys(item: StatementAiRow): string[] {
    const keys: string[] = item.row.evidence.filter((evidence: SourceEvidence): boolean => !!evidence.rawText.trim()).map((evidence: SourceEvidence): string =>
        JSON.stringify(['evidence', item.row.accountSectionId, evidence.pageId, evidence.region, evidence.rawText.normalize('NFC').trim().replace(/\s+/g, ' ')]));
    const transactionIds: Set<string> = new Set(item.row.references.filter((field: StatementAiRow['row']['references'][number]): boolean => /^transaction\s+id$/i.test(field.label.trim()))
        .map((field: StatementAiRow['row']['references'][number]): string => field.value.trim()).filter(Boolean));
    for (const field of item.row.references) {
        if (transactionIds.size === 1 && /^transaction\s+id$/i.test(field.label.trim()) && field.value.trim() && field.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText.includes(field.value))) {
            keys.push(JSON.stringify(['transaction-id', item.row.accountSectionId, field.value.trim()]));
        }
    }
    return [...new Set(keys)];
}

function indexEvidence(items: StatementAiRow[]): Map<string, StatementAiRow[]> {
    const index: Map<string, StatementAiRow[]> = new Map();
    for (const item of items) {
        for (const key of evidenceKeys(item)) {
            index.set(key, [...index.get(key) ?? [], item]);
        }
    }
    return index;
}

function pairRows(before: StatementAiRow[], after: StatementAiRow[]): Map<string, StatementAiRow> {
    const current: Map<string, StatementAiRow> = new Map(before.map((item: StatementAiRow): [string, StatementAiRow] => [item.id, item]));
    const paired: Map<string, StatementAiRow> = new Map(after.filter((item: StatementAiRow): boolean => current.has(item.id)).map((item: StatementAiRow): [string, StatementAiRow] => [item.id, item]));
    const beforeEvidence: Map<string, StatementAiRow[]> = indexEvidence(before);
    const afterEvidence: Map<string, StatementAiRow[]> = indexEvidence(after);
    const candidates: Map<string, Set<string>> = new Map();
    const owners: Map<string, Set<string>> = new Map();
    for (const [key, old] of beforeEvidence) {
        const next: StatementAiRow[] | undefined = afterEvidence.get(key);
        if (old.length !== 1 || next?.length !== 1 || paired.has(old[0].id) || current.has(next[0].id)) {
            continue;
        }
        candidates.set(old[0].id, new Set([...(candidates.get(old[0].id) ?? []), next[0].id]));
        owners.set(next[0].id, new Set([...(owners.get(next[0].id) ?? []), old[0].id]));
    }
    const proposed: Map<string, StatementAiRow> = new Map(after.map((item: StatementAiRow): [string, StatementAiRow] => [item.id, item]));
    for (const [id, matches] of candidates) {
        const next: string = [...matches][0];
        if (matches.size === 1 && owners.get(next)?.size === 1) {
            paired.set(id, proposed.get(next)!);
        }
    }
    return paired;
}

function changeKind(before: StatementAiRow, after: StatementAiRow): StatementAiChange['kind'] {
    if (before.kind !== after.kind) {
        return after.kind === 'transaction' ? 'promoted' : 'demoted';
    }
    return isDeepStrictEqual(values(before), values(after)) ? 'unchanged' : 'changed';
}

export function prepareStatementAnalysis(original: StoredBankImport, current: StoredBankImport, proposed: BankImportResult, protectedIds: ReadonlySet<string> = new Set()): StatementAnalysisPlan {
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, current, proposed);
    const before: StatementAiRow[] = identifiedRows(current), after: StatementAiRow[] = identifiedRows(version.record);
    const pairs: Map<string, StatementAiRow> = pairRows(before, after);
    const pairedAfter: Set<string> = new Set([...pairs.values()].map((item: StatementAiRow): string => item.id));
    const beforeIds: Map<string, string> = new Map(before.map((item: StatementAiRow): [string, string] => [item.row.rowId, item.id]));
    const afterAliases: Map<string, string> = new Map([...pairs].map(([id, item]: [string, StatementAiRow]): [string, string] => [item.id, id]));
    const afterIds: Map<string, string> = new Map(after.map((item: StatementAiRow): [string, string] => [item.row.rowId, afterAliases.get(item.id) ?? item.id]));
    const sameIssues: boolean = isDeepStrictEqual(normalizedIssues(current.result.issues, beforeIds), normalizedIssues(version.record.result.issues, afterIds));
    const changes: StatementAiChange[] = [...before.map((item: StatementAiRow): StatementAiChange => {
        const next: StatementAiRow | undefined = pairs.get(item.id);
        return { kind: next ? changeKind(item, next) : 'removed', before: item, after: next ?? null };
    }), ...after.filter((item: StatementAiRow): boolean => !pairedAfter.has(item.id)).map((item: StatementAiRow): StatementAiChange => ({ kind: 'added', before: null, after: item }))];
    const summary: StatementAiSummary = { unchanged: 0, added: 0, removed: 0, changed: 0, promoted: 0, demoted: 0,
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
    const activeIds: Set<string> = new Set(after.map((item: StatementAiRow): string => item.id));
    const blocked: number = before.filter((item: StatementAiRow): boolean => protectedIds.has(item.id) && !activeIds.has(item.id)).length;
    const noChanges: boolean = sameIssues && changes.every((change: StatementAiChange): boolean => change.kind === 'unchanged');
    const blockingConflict: string | undefined = blocked ? `${blocked} protected bank rows would change or disappear. Existing corrections and review decisions must be preserved.` :
        noChanges ? 'The proposed statement analysis contains no verified changes.' : undefined;
    return { version, changes, summary, conflicts, ...(blockingConflict ? { blockingConflict } : {}) };
}
