import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { prepareStatementAnalysis, type IStatementAnalysisPlan } from '../../electron/import/prepare-statement-analysis.js';
import type { BankImportResult, TransactionCandidate } from '../../src/shared/bank-import.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { retainedBank } from './document-fixtures.js';

function proposal(record: StoredBankImport): BankImportResult {
    return { ...structuredClone(record.result), adapter: null, localRecognition: { model: 'nuextract3', parserVersion: '1' } };
}

test('unchanged rows and normalized warnings block metadata-only adoption while preserving original evidence', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const id: string = original.result.transactions[0].rowId;
    original.result.status = 'partial';
    original.result.issues.push({ code: 'source-warning', severity: 'warning', field: 'bookingDate', message: 'Check the source.', pageId: 'page-1', rowId: id, evidence: original.result.transactions[0].evidence });
    const before: StoredBankImport = structuredClone(original);
    const proposed: BankImportResult = proposal(original);
    proposed.sourceProvenance!.extractionRunId = randomUUID();
    proposed.transactions[0].rowId = 'new-local-row';
    proposed.issues[0].rowId = 'new-local-row';
    const plan: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed);
    assert.match(plan.blockingConflict!, /no verified changes/);
    assert.equal(plan.summary.unchanged, 2);
    assert.deepEqual(plan.conflicts, []);
    assert.equal(plan.version.record.transactions[0].transactionId, original.transactions[0].transactionId);
    assert.deepEqual(plan.changes[0].before!.row.evidence, before.result.transactions[0].evidence);
    assert.deepEqual(original, before);
    proposed.issues[0].rowId = proposed.transactions[1].rowId;
    const moved: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed);
    assert.equal(moved.blockingConflict, undefined);
    assert.equal(moved.conflicts.length, 1);
});

test('source-supported changed values, promotions and demotions are explicit without reusing their old UUID', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const changed: BankImportResult = proposal(original);
    changed.transactions[0].bookingDate.value = '2032-02-26';
    const plan: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, changed);
    assert.equal(plan.summary.changed, 1);
    assert.equal(plan.summary.unchanged, 1);
    assert.equal(plan.changes[0].before!.id, original.transactions[0].transactionId);
    assert.notEqual(plan.changes[0].after!.id, plan.changes[0].before!.id);
    const demoted: BankImportResult = proposal(original);
    const row: TransactionCandidate = demoted.transactions.shift()!;
    demoted.status = 'partial';
    const issues: BankImportResult['issues'] = [{ code: 'invalid-date', severity: 'warning', field: 'bookingDate', message: 'Unreadable source date.',
        pageId: 'page-1', rowId: row.rowId, evidence: row.evidence }];
    demoted.unresolvedDrafts = [{ ...row, bookingDate: null, issues }];
    demoted.issues = issues;
    const demotion: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, demoted);
    assert.equal(demotion.summary.demoted, 1);
    assert.equal(demotion.summary.afterDrafts, 1);
    const promotion: IStatementAnalysisPlan = prepareStatementAnalysis(original, demotion.version.record, proposal(original));
    assert.equal(promotion.summary.promoted, 1);
    assert.equal(promotion.summary.afterDrafts, 0);
    assert.notEqual(promotion.version.record.transactions[0].transactionId, demotion.version.record.drafts[0].draftId);
});

test('ambiguous evidence and matching array positions never imply a changed-row correspondence', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    original.result.transactions[1].evidence = structuredClone(original.result.transactions[0].evidence);
    const proposed: BankImportResult = proposal(original);
    proposed.transactions.forEach((row: TransactionCandidate): void => {
        row.bookingDate.value = '2032-02-26';
    });
    const ambiguous: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed);
    assert.equal(ambiguous.summary.changed, 0);
    assert.equal(ambiguous.summary.removed, 2);
    assert.equal(ambiguous.summary.added, 2);
    const separate: StoredBankImport = retainedBank(process.cwd());
    const ungrounded: BankImportResult = proposal(separate);
    ungrounded.transactions[0].bookingDate.value = '2032-02-26';
    ungrounded.transactions[0].evidence.forEach((evidence: TransactionCandidate['evidence'][number]): void => {
        evidence.rawText = 'Unrelated source text';
    });
    const unpaired: IStatementAnalysisPlan = prepareStatementAnalysis(separate, separate, ungrounded);
    assert.equal(unpaired.summary.changed, 0);
    assert.equal(unpaired.summary.removed, 1);
    assert.equal(unpaired.summary.added, 1);
});

test('only unambiguous source-corroborated transaction references support pairing across changed source evidence', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const row: TransactionCandidate = original.result.transactions[0];
    row.references.push({ label: 'Transaction ID', value: 'SYNTHETIC-TX-1', evidence: [{ ...row.evidence[0], rawText: 'Transaction ID: SYNTHETIC-TX-1' }] });
    const proposed: BankImportResult = proposal(original);
    proposed.transactions[0].bookingDate.value = '2032-02-26';
    proposed.transactions[0].evidence.forEach((evidence: TransactionCandidate['evidence'][number]): void => {
        evidence.rawText = 'Different extraction text';
    });
    assert.equal(prepareStatementAnalysis(original, original, proposed).summary.changed, 1);
    proposed.transactions[0].references.at(-1)!.evidence[0].rawText = 'Uncorroborated reference';
    const unpaired: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed);
    assert.equal(unpaired.summary.changed, 0);
    assert.equal(unpaired.summary.removed, 1);
    assert.equal(unpaired.summary.added, 1);
});

test('protected identities block changed and removed rows while unrelated unchanged protections remain intact', (): void => {
    const original: StoredBankImport = retainedBank(process.cwd());
    const proposed: BankImportResult = proposal(original);
    proposed.transactions[0].bookingDate.value = '2032-02-26';
    const changed: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed, new Set([original.transactions[0].transactionId]));
    assert.match(changed.blockingConflict!, /protected bank rows/);
    assert.equal(changed.summary.changed, 1);
    const allowed: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed, new Set([original.transactions[1].transactionId]));
    assert.equal(allowed.blockingConflict, undefined);
    proposed.transactions.shift();
    const removed: IStatementAnalysisPlan = prepareStatementAnalysis(original, original, proposed, new Set([original.transactions[0].transactionId]));
    assert.match(removed.blockingConflict!, /protected bank rows/);
    assert.equal(removed.summary.removed, 1);
});
