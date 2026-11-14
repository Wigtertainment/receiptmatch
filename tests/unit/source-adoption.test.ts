import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { reconciliationRows } from '../../electron/reconciliation-csv.js';
import { approvalSelectionFor } from '../../src/shared/match-approvals.js';
import { PDF_EXTRACTION_VERSION } from '../../src/shared/pdf-extraction.js';
import { documentRun, extractedDocument, retainedBank, retainedDocument } from './document-fixtures.js';
import { statement } from './bank-fixtures.js';

async function fixture(context: TestContext, kind: 'statement' | 'document', unrelated = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-replacement-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'test.receiptmatch'), replacement = path.join(root, 'replacement.pdf');
    const bankInput = statement();
    const accountSpan = bankInput.pages[0].spans.find(span => /IBAN|Account identifier/i.test(span.text));
    if (!accountSpan) bankInput.pages[0].spans.push({ text: 'Account identifier: SYNTHETIC-CHECKING', region: { x: 25, y: 105, width: 230, height: 8 }, method: 'embedded-text' });
    const bank = retainedBank(root, bankInput), receipt = retainedDocument(root);
    const transactionId = bank.transactions[0].transactionId;
    const approvals = new Map([[transactionId, { associationRevision: 1, approval: {
        ...approvalSelectionFor(transactionId, receipt.id), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z',
    } }]]);
    await createWorkspace(workspace, newMetadata(), [bank], [documentRun(root, [receipt])], new Map([[transactionId, receipt.id]]), new Map(), new Map(), approvals);
    await writeFile(replacement, 'new synthetic bytes');
    const session = new WorkspaceSession({ open: async () => workspace, save: async () => workspace, unsaved: async () => 'discard',
        analyzeOriginal: async () => replacement }, undefined, undefined, undefined, async (bytes, sourceId) => {
        if (kind === 'statement') return { status: 'complete', input: { ...bankInput, source: { sourceId, sha256: createHash('sha256').update(bytes).digest('hex') },
            extraction: { runId: randomUUID(), version: PDF_EXTRACTION_VERSION } } };
        const extracted = extractedDocument(bytes, sourceId);
        const total = extracted.input.pages[0].spans.find(span => span.text.startsWith('Invoice Total'))!;
        total.text = 'Invoice Total: EUR 84.00';
        if (unrelated) {
            for (const span of extracted.input.pages[0].spans) {
                span.text = span.text.replace('Cedar Workshop', 'Different Merchant').replace('SYNTHETIC-ONLY', 'OTHER-INVOICE');
            }
        }
        return extracted;
    });
    await session.dispatch({ type: 'open' });
    const analyze = () => session.analyzeOriginal({ kind, id: kind === 'statement' ? bank.id : receipt.id, loadRevision: session.state().workspace!.loadRevision });
    const accept = (token: string, acknowledgeConflicts = false) => session.acceptOriginalAnalysis({ token, acknowledgeConflicts, loadRevision: session.state().workspace!.loadRevision });
    return { workspace, replacement, bank, receipt, transactionId, session, analyze, accept };
}

test('stages a changed document, keeps its prior review in history and revokes only the affected approval after adoption', async (context) => {
    const { workspace, receipt, transactionId, session, analyze, accept } = await fixture(context, 'document');
    const before = await readFile(workspace);
    const analysis = await analyze();
    assert.equal(analysis.status, 'ready');
    if (analysis.status !== 'ready') return;
    assert.equal(analysis.comparison.revoked, 1);
    assert.ok(analysis.comparison.changes.some(change => change.after?.includes('84.00')));
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(await readFile(workspace), before);
    assert.deepEqual(await accept(analysis.comparison.token, true), { status: 'adopted' });
    assert.equal(session.state().workspace?.approvedDocumentCount, 0);
    assert.deepEqual(session.state().workspace?.supersededDocuments, [receipt.id]);
    assert.equal(session.documentImports().length, 2);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved = await loadWorkspace(workspace);
    assert.equal(saved.archivedSourceReviews.get(receipt.result.input!.source.sourceId)?.get(transactionId), receipt.id);
    assert.notEqual(saved.matchDecisions.get(transactionId), receipt.id);
    await session.dispatch({ type: 'open' });
    assert.equal(session.state().workspace?.approvedDocumentCount, 0);
    assert.equal(reconciliationRows(saved).find(row => row.transaction_id === transactionId)?.document_file, 'replacement.pdf');
});

test('rechecks file bytes before adopting a staged analysis', async (context) => {
    const { workspace, replacement, session, analyze, accept } = await fixture(context, 'document');
    const before = await readFile(workspace);
    const analysis = await analyze();
    if (analysis.status !== 'ready') assert.fail(JSON.stringify(analysis));
    await writeFile(replacement, 'changed since analysis');
    assert.equal((await accept(analysis.comparison.token, true)).status, 'failed');
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(await readFile(workspace), before);
});

test('requires acknowledgement for an unrelated document and leaves the previous assignment in history', async (context) => {
    const { workspace, receipt, transactionId, session, analyze, accept } = await fixture(context, 'document', true);
    const analysis = await analyze();
    if (analysis.status !== 'ready') assert.fail(JSON.stringify(analysis));
    assert.ok(analysis.comparison.conflicts.length);
    assert.equal((await accept(analysis.comparison.token)).status, 'failed');
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(await accept(analysis.comparison.token, true), { status: 'adopted' });
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved = await loadWorkspace(workspace);
    assert.equal(saved.matchDecisions.has(transactionId), false);
    assert.equal(saved.archivedSourceReviews.get(receipt.result.input!.source.sourceId)?.get(transactionId), receipt.id);
});

test.for([false, true])('keeps the review and approval for an unchanged booking in a replacement statement (ignored: %s)', async (ignored, context) => {
    const { workspace, bank, transactionId, session, analyze, accept } = await fixture(context, 'statement');
    assert.ok(bank.result.accountSections[0].accountReference);
    if (ignored) {
        assert.equal((await session.dispatch({ type: 'set-transaction-ignored', revision: session.state().workspace!.matchRevision, transactionId, ignored })).error, null);
    }
    const analysis = await analyze();
    if (analysis.status !== 'ready') assert.fail(JSON.stringify(analysis));
    assert.equal(analysis.comparison.preserved, 1);
    assert.equal(analysis.comparison.revoked, 0);
    assert.deepEqual(await accept(analysis.comparison.token), { status: 'adopted' });
    assert.equal(session.state().workspace?.approvedDocumentCount, ignored ? 0 : 1);
    assert.deepEqual(session.state().workspace?.supersededStatements, [bank.id]);
    assert.ok(!session.matchResults().some(match => match.transactionId === transactionId));
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved = await loadWorkspace(workspace);
    assert.equal(saved.imports.length, 2);
    assert.equal(reconciliationRows(saved).filter(row => row.row_type === 'transaction').length, bank.transactions.length);
    const rows = reconciliationRows(saved);
    assert.equal(rows.filter(row => row.approval_status === 'approved').length, ignored ? 0 : 1);
    if (ignored) {
        const replacementId = [...saved.ignoredTransactions][0];
        assert.notEqual(replacementId, transactionId);
        assert.equal(rows.find(row => row.transaction_id === replacementId)?.review_status, 'ignored');
        assert.ok(saved.reviewApprovals.get(replacementId)?.approval);
    }
});
