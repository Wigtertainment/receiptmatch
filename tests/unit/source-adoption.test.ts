import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { BankImportInput, PositionedSpan } from "../../src/shared/bank-import.js";
import type { TransactionMatch } from "../../src/shared/workspace-matching.js";
import type { OriginalAdoptionResult } from "../../src/shared/original-preview.js";
import type { OriginalAnalysisResult } from "../../src/shared/original-preview.js";
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { reconciliationRows } from '../../electron/reconciliation-csv.js';
import { approvalSelectionFor } from '../../src/shared/match-approvals.js';
import { PDF_EXTRACTION_VERSION } from '../../src/shared/pdf-extraction.js';
import { documentRun, extractedDocument, retainedBank, retainedDocument } from './document-fixtures.js';
import { statement } from './bank-fixtures.js';

async function fixture(context: TestContext, kind: 'statement' | 'document', unrelated: boolean = false): Promise<{ workspace: string; replacement: string; bank: StoredBankImport; receipt: StoredSupportingDocument; transactionId: string; session: WorkspaceSession; analyze: () => Promise<OriginalAnalysisResult>; accept: (token: string, acknowledgeConflicts?: boolean) => Promise<OriginalAdoptionResult>; }> {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-replacement-'));
    context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
    const workspace: string = path.join(root, 'test.receiptmatch'), replacement: string = path.join(root, 'replacement.pdf');
    const bankInput: BankImportInput = statement();
    const accountSpan: PositionedSpan | undefined = bankInput.pages[0].spans.find((span: PositionedSpan): boolean => /IBAN|Account identifier/i.test(span.text));
    if (!accountSpan) {
        bankInput.pages[0].spans.push({ text: 'Account identifier: SYNTHETIC-CHECKING', region: { x: 25, y: 105, width: 230, height: 8 }, method: 'embedded-text' });
    }
    const bank: StoredBankImport = retainedBank(root, bankInput), receipt: StoredSupportingDocument = retainedDocument(root);
    const transactionId: string = bank.transactions[0].transactionId;
    const approvals: Map<string, { associationRevision: number; approval: { batchId: `${string}-${string}-${string}-${string}-${string}`; approvedAt: string; transactionId: string; documentId: string; transactionRevision: number; documentRevision: number; associationRevision: number; }; }> = new Map([[transactionId, { associationRevision: 1, approval: {
        ...approvalSelectionFor(transactionId, receipt.id), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z',
    } }]]);
    await createWorkspace(workspace, newMetadata(), [bank], [documentRun(root, [receipt])], new Map([[transactionId, receipt.id]]), new Map(), new Map(), approvals);
    await writeFile(replacement, 'new synthetic bytes');
    const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(workspace), save: async (): Promise<string> => Promise.resolve(workspace), unsaved: async (): Promise<"discard"> => Promise.resolve('discard'),
        analyzeOriginal: async (): Promise<string> => Promise.resolve(replacement) }, undefined, undefined, undefined, async (bytes: Uint8Array<ArrayBufferLike>, sourceId: string): Promise<{ status: "complete"; input: BankImportInput; } & { status: "complete"; }> => {
        if (kind === 'statement') {
            return Promise.resolve({ status: 'complete', input: { ...bankInput, source: { sourceId, sha256: createHash('sha256').update(bytes).digest('hex') },
            extraction: { runId: randomUUID(), version: PDF_EXTRACTION_VERSION } } });
        }
        const extracted: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(bytes, sourceId);
        const total: PositionedSpan = extracted.input.pages[0].spans.find((span: PositionedSpan): boolean => span.text.startsWith('Invoice Total'))!;
        total.text = 'Invoice Total: EUR 84.00';
        if (unrelated) {
            for (const span of extracted.input.pages[0].spans) {
                span.text = span.text.replace('Cedar Workshop', 'Different Merchant').replace('SYNTHETIC-ONLY', 'OTHER-INVOICE');
            }
        }
        return Promise.resolve(extracted);
    });
    await session.dispatch({ type: 'open' });
    const analyze: () => Promise<OriginalAnalysisResult> = (): Promise<OriginalAnalysisResult> => session.analyzeOriginal({ kind, id: kind === 'statement' ? bank.id : receipt.id, loadRevision: session.state().workspace!.loadRevision });

    const accept: (token: string, acknowledgeConflicts?: boolean) => Promise<OriginalAdoptionResult> = (token: string, acknowledgeConflicts: boolean = false): Promise<OriginalAdoptionResult> => session.acceptOriginalAnalysis({ token, acknowledgeConflicts, loadRevision: session.state().workspace!.loadRevision });
    return { workspace, replacement, bank, receipt, transactionId, session, analyze, accept };
}

test('stages a changed document, keeps its prior review in history and revokes only the affected approval after adoption', async (context: TestContext & object): Promise<void> => {
    const { workspace, receipt, transactionId, session, analyze, accept }: Awaited<ReturnType<typeof fixture>> = await fixture(context, 'document');
    const before: NonSharedBuffer = await readFile(workspace);
    const analysis: OriginalAnalysisResult = await analyze();
    assert.equal(analysis.status, 'ready');
    if (analysis.status !== 'ready') {
        return;
    }
    assert.equal(analysis.comparison.revoked, 1);
    assert.ok(analysis.comparison.changes.some((change: { label: string; before: string | null; after: string | null; }): boolean | undefined => change.after?.includes('84.00')));
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(await readFile(workspace), before);
    assert.deepEqual(await accept(analysis.comparison.token, true), { status: 'adopted' });
    assert.equal(session.state().workspace?.approvedDocumentCount, 0);
    assert.deepEqual(session.state().workspace?.supersededDocuments, [receipt.id]);
    assert.equal(session.documentImports().length, 2);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved: SavedWorkspace = await loadWorkspace(workspace);
    assert.equal(saved.archivedSourceReviews.get(receipt.result.input!.source.sourceId)?.get(transactionId), receipt.id);
    assert.notEqual(saved.matchDecisions.get(transactionId), receipt.id);
    await session.dispatch({ type: 'open' });
    assert.equal(session.state().workspace?.approvedDocumentCount, 0);
    assert.equal(reconciliationRows(saved).find((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): boolean => row.transaction_id === transactionId)?.document_file, 'replacement.pdf');
});

test('rechecks file bytes before adopting a staged analysis', async (context: TestContext & object): Promise<void> => {
    const { workspace, replacement, session, analyze, accept }: Awaited<ReturnType<typeof fixture>> = await fixture(context, 'document');
    const before: NonSharedBuffer = await readFile(workspace);
    const analysis: OriginalAnalysisResult = await analyze();
    if (analysis.status !== 'ready') {
        assert.fail(JSON.stringify(analysis));
    }
    await writeFile(replacement, 'changed since analysis');
    assert.equal((await accept(analysis.comparison.token, true)).status, 'failed');
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(await readFile(workspace), before);
});

test('requires acknowledgement for an unrelated document and leaves the previous assignment in history', async (context: TestContext & object): Promise<void> => {
    const { workspace, receipt, transactionId, session, analyze, accept }: Awaited<ReturnType<typeof fixture>> = await fixture(context, 'document', true);
    const analysis: OriginalAnalysisResult = await analyze();
    if (analysis.status !== 'ready') {
        assert.fail(JSON.stringify(analysis));
    }
    assert.ok(analysis.comparison.conflicts.length);
    assert.equal((await accept(analysis.comparison.token)).status, 'failed');
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(await accept(analysis.comparison.token, true), { status: 'adopted' });
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved: SavedWorkspace = await loadWorkspace(workspace);
    assert.equal(saved.matchDecisions.has(transactionId), false);
    assert.equal(saved.archivedSourceReviews.get(receipt.result.input!.source.sourceId)?.get(transactionId), receipt.id);
});

test.for([false, true])('keeps the review and approval for an unchanged booking in a replacement statement (ignored: %s)', async (ignored: boolean, context: TestContext & object): Promise<void> => {
    const { workspace, bank, transactionId, session, analyze, accept }: Awaited<ReturnType<typeof fixture>> = await fixture(context, 'statement');
    assert.ok(bank.result.accountSections[0].accountReference);
    if (ignored) {
        assert.equal((await session.dispatch({ type: 'set-transaction-ignored', revision: session.state().workspace!.matchRevision, transactionId, ignored })).error, null);
    }
    const analysis: OriginalAnalysisResult = await analyze();
    if (analysis.status !== 'ready') {
        assert.fail(JSON.stringify(analysis));
    }
    assert.equal(analysis.comparison.preserved, 1);
    assert.equal(analysis.comparison.revoked, 0);
    assert.deepEqual(await accept(analysis.comparison.token), { status: 'adopted' });
    assert.equal(session.state().workspace?.approvedDocumentCount, ignored ? 0 : 1);
    assert.deepEqual(session.state().workspace?.supersededStatements, [bank.id]);
    assert.ok(!session.matchResults().some((match: TransactionMatch): boolean => match.transactionId === transactionId));
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved: SavedWorkspace = await loadWorkspace(workspace);
    assert.equal(saved.imports.length, 2);
    assert.equal(reconciliationRows(saved).filter((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): boolean => row.row_type === 'transaction').length, bank.transactions.length);
    const rows: import('../../electron/reconciliation-csv.js').ReconciliationRow[] = reconciliationRows(saved);
    assert.equal(rows.filter((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): boolean => row.approval_status === 'approved').length, ignored ? 0 : 1);
    if (ignored) {
        const replacementId: string = [...saved.ignoredTransactions][0];
        assert.notEqual(replacementId, transactionId);
        assert.equal(rows.find((row: import('../../electron/reconciliation-csv.js').ReconciliationRow): boolean => row.transaction_id === replacementId)?.review_status, 'ignored');
        assert.ok(saved.reviewApprovals.get(replacementId)?.approval);
    }
});
