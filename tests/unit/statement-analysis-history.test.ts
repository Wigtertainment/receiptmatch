import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { historicalStatementImports, prepareStatementAnalysisVersion, projectCorrectedStatementAnalyses, projectStatementAnalyses } from '../../electron/import/statement-analyses.js';
import { type BankImportResult, type TransactionCandidate } from '../../src/shared/bank-import.js';
import type { BankCorrection } from '../../src/shared/bank-corrections.js';
import { statementAnalysisVersionSchema, type StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { retainedBank } from './document-fixtures.js';
import { indexStatementOverlaps, originalStatementBankIds } from '../../src/shared/statement-overlaps.js';
import { validateDuplicateDecisions, type DuplicateDecision } from '../../src/shared/transaction-duplicates.js';

function proposal(record: StoredBankImport): BankImportResult {
    return { ...structuredClone(record.result), adapter: null, localRecognition: { model: 'nuextract3', parserVersion: '1' } };
}

test('statement history retains the original and reuses only unambiguous unchanged rows independently of source row order', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const before: StoredBankImport = structuredClone(original);
    const proposed: BankImportResult = proposal(original);
    proposed.transactions.reverse();
    proposed.transactions.forEach((row: TransactionCandidate, index: number): void => {
        row.rowId = 'ai-' + index;
    });
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposed);
    assert.equal(version.record.transactions[0].transactionId, original.transactions[1].transactionId);
    assert.equal(version.record.transactions[1].transactionId, original.transactions[0].transactionId);
    assert.deepEqual(projectStatementAnalyses([original], [version]), [version.record]);
    assert.deepEqual(original, before);
    assert.deepEqual(version.record.accounts, original.accounts);
    assert.equal(version.record.result.adapter, null);
    assert.equal(version.record.result.localRecognition?.model, 'nuextract3');
});

test('changed, restored, promoted, demoted and ambiguous rows get fresh identities without resurrection', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const changed: BankImportResult = proposal(original);
    changed.transactions[0].description.value = 'Changed source reading';
    const first: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, changed);
    assert.notEqual(first.record.transactions[0].transactionId, original.transactions[0].transactionId);
    const restored: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, first.record, proposal(original));
    assert.notEqual(restored.record.transactions[0].transactionId, original.transactions[0].transactionId);
    const forged: StatementAnalysisVersion = structuredClone(restored);
    forged.record.transactions[0].transactionId = original.transactions[0].transactionId;
    assert.throws((): StoredBankImport[] => projectStatementAnalyses([original], [first, forged]), /historical row identity/);
    const demoted: BankImportResult = proposal(original);
    const row: TransactionCandidate = demoted.transactions.shift()!;
    demoted.status = 'partial';
    demoted.unresolvedDrafts.push({ ...row, bookingDate: null, issues: [{ code: 'invalid-date', severity: 'warning', message: 'Unreadable date.',
        pageId: row.evidence[0].pageId, rowId: row.rowId, field: 'bookingDate', evidence: row.evidence }] });
    demoted.issues.push(...demoted.unresolvedDrafts[0].issues);
    const second: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, demoted);
    assert.notEqual(second.record.drafts[0].draftId, original.transactions[0].transactionId);
    const promoted: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, second.record, proposal(original));
    assert.notEqual(promoted.record.transactions[0].transactionId, second.record.drafts[0].draftId);
    const duplicate: BankImportResult = proposal(original);
    duplicate.transactions.push({ ...structuredClone(duplicate.transactions[0]), rowId: 'duplicate' });
    const ambiguous: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, duplicate);
    assert.notEqual(ambiguous.record.transactions[0].transactionId, original.transactions[0].transactionId);
    assert.notEqual(ambiguous.record.transactions[2].transactionId, original.transactions[0].transactionId);
});

test('statement history rejects provenance, account, parser and UUID tampering', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    for (const modify of [
        (result: BankImportResult): void => {
            result.sourceProvenance!.sha256 = 'f'.repeat(64);
        },
        (result: BankImportResult): void => {
            result.sourceProvenance!.sourceId = randomUUID();
        },
        (result: BankImportResult): void => {
            result.accountSections[0].currency.value = 'USD';
        },
        (result: BankImportResult): void => {
            result.accountSections[0].accountReference!.value = 'DIFFERENT ACCOUNT';
        },
        (result: BankImportResult): void => {
            result.localRecognition = { model: 'paddleocr-vl-1.6', parserVersion: '1' };
        }
    ]) {
        const proposed: BankImportResult = proposal(original);
        modify(proposed);
        assert.throws((): StatementAnalysisVersion => prepareStatementAnalysisVersion(original, original, proposed));
    }
    const proposed: BankImportResult = proposal(original);
    proposed.accountSections[0].sectionId = 'statement';
    proposed.accountSections[0].accountReference = null;
    proposed.transactions.forEach((row: TransactionCandidate): void => {
        row.accountSectionId = 'statement';
    });
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposed);
    assert.deepEqual(version.record.result.accountSections, original.result.accountSections);
    const forged: StatementAnalysisVersion = structuredClone(version);
    forged.record.accounts[0].statementId = randomUUID();
    assert.throws((): StoredBankImport[] => projectStatementAnalyses([original], [forged]), /original import/);
    assert.equal(statementAnalysisVersionSchema.safeParse({ ...version, importId: randomUUID() }).success, false);
});

test('corrections validate against retained history but affect only the active analysis', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const proposed: BankImportResult = proposal(original);
    proposed.transactions[0].description.value = 'New source reading';
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposed);
    const id: string = original.transactions[0].transactionId;
    const correction: BankCorrection = { rowId: id, revision: 2, bookingDate: '2032-03-01' };
    const corrections: Map<string, BankCorrection> = new Map([[id, correction]]);
    const active: StoredBankImport[] = projectCorrectedStatementAnalyses([original], [version], corrections);
    assert.equal(active[0].result.transactions[0].bookingDate.value, original.result.transactions[0].bookingDate.value);
    const history: StoredBankImport[] = historicalStatementImports([original], [version], corrections);
    assert.equal(history[0].transactions.length, 3);
    assert.equal(history[0].result.transactions.find((row: TransactionCandidate): boolean => row.rowId === id)!.bookingDate.value, '2032-03-01');
    assert.throws((): StoredBankImport[] => projectCorrectedStatementAnalyses([original], [version], new Map([[randomUUID(), correction]])), /outside the statement history/);
});

test('same-source bank context preserves comparison and duplicate decisions without claiming an AI adapter', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const other: StoredBankImport = retainedBank(process.cwd());
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposal(original));
    const active: StoredBankImport[] = [version.record, other];
    const scope: Map<string, string> = originalStatementBankIds([original, other]);
    const id: string = original.transactions[0].transactionId;
    assert.equal(indexStatementOverlaps(active)(original.id).has(id), false);
    assert.equal(indexStatementOverlaps(active, scope)(original.id).has(id), true);
    const pair: string[] = [id, other.transactions[0].transactionId].sort();
    const duplicate: DuplicateDecision = { firstId: pair[0], secondId: pair[1], primaryId: null, archivedReview: null };
    assert.throws((): Map<string, DuplicateDecision> => validateDuplicateDecisions([duplicate], active), /different statements/);
    assert.equal(validateDuplicateDecisions([duplicate], active, scope).size, 1);
    assert.equal(version.record.result.adapter, null);
    assert.equal(originalStatementBankIds([version.record]).size, 0);
    const unrelated: StoredBankImport = { ...version.record, id: randomUUID() };
    assert.equal(indexStatementOverlaps([unrelated, other], scope)(unrelated.id).has(id), false);
});
