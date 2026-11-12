import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { reconciliationCsvColumns, reconciliationRows, serializeReconciliationCsv } from '../../electron/reconciliation-csv.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace } from '../../electron/store.js';
import { advanceReviewRevision, approvalSelectionFor } from '../../src/shared/match-approvals.js';
import type { DocumentExportOutcome } from '../../src/shared/document-export.js';
import { row, statement } from './bank-fixtures.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

test('projects saved bookings, approval and copy outcomes, and unresolved rows without duplicating promoted drafts', async context => {
	const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-reconciliation-'));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const input = statement();
	input.pages[0].spans.push(...row(335, '26 Feb 2032', 'To: Cedar Tools', null, null),
		...row(385, '25 Feb 2032', '', null, null).filter(span => span.text));
	const bank = retainedBank(root, input);
	bank.filePath = 'C:\\synthetic\\bank.pdf';
	const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
	const [{ draftId: promoted }, { draftId: unresolved }] = bank.drafts;
	const document = retainedDocument(root, 'Résumé.pdf');
	const replacement = retainedDocument(root, 'replacement.pdf');
	const approval = { ...approvalSelectionFor(first, document.id), batchId: randomUUID(), approvedAt: '2032-02-29T12:00:00.000Z' };
	const file = path.join(root, 'workspace.receiptmatch');
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [document, replacement])], new Map([[first, document.id], [second, null]]),
		new Map([[promoted, { rowId: promoted, revision: 2, accountAmount: { currency: 'EUR', coefficient: '-90071992547409932700', scale: 4 } }]]),
		new Map(), new Map([[first, { associationRevision: 1, approval }]]));
	const snapshot = await loadWorkspace(file);
	const rows = reconciliationRows(snapshot);
	assert.equal(rows.length, 4);
	const [approved, completed, corrected, draft] = rows;
	assert.equal(approved.transaction_id, first);
	assert.equal(approved.statement_id, bank.accounts[0].statementId);
	assert.equal(approved.statement_file, 'bank.pdf');
	assert.equal(approved.account_amount, '-1234.56');
	assert.equal(approved.account_currency, 'EUR');
	assert.equal(approved.original_amount, '-1500.01');
	assert.equal(approved.original_currency, 'USD');
	assert.equal(approved.review_status, 'assigned');
	assert.equal(approved.match_status, 'unmatched');
	assert.equal(approved.approval_status, 'approved');
	assert.equal(approved.approval_batch_id, approval.batchId);
	assert.equal(approved.approved_at, approval.approvedAt);
	assert.equal(approved.document_id, document.id);
	assert.equal(approved.document_file, 'Résumé.pdf');
	assert.equal(approved.copy_status, 'not-attempted');
	assert.equal(completed.transaction_id, second);
	assert.equal(completed.review_status, 'completed-without-document');
	assert.equal(completed.copy_status, 'not-eligible');
	assert.equal(completed.document_id, '');
	assert.equal(corrected.row_type, 'transaction');
	assert.equal(corrected.transaction_id, promoted);
	assert.equal(corrected.draft_id, '');
	assert.equal(corrected.account_amount, '-9007199254740993.2700');
	assert.equal(corrected.review_status, 'open');
	assert.equal(draft.row_type, 'unresolved');
	assert.equal(draft.draft_id, unresolved);
	assert.equal(draft.transaction_id, '');
	assert.equal(draft.account_amount, '');
	assert.equal(draft.account_currency, '');
	assert.equal(draft.approval_status, '');
	assert.ok(draft.import_issue_codes.split('|').includes('missing-field'));

	const outcome: DocumentExportOutcome = { transactionId: first, documentId: document.id, sourceName: 'Résumé.pdf',
		sourcePath: document.filePath, status: 'copied', filename: '2026_Export.pdf' };
	const [copied] = reconciliationRows(snapshot, [outcome]);
	assert.equal(copied.copy_status, 'copied');
	assert.equal(copied.exported_file, 'documents/2026_Export.pdf');
	assert.equal(copied.copy_reason, '');
	const [skipped] = reconciliationRows(snapshot, [{ ...outcome, status: 'skipped', reason: 'collision' }]);
	assert.equal(skipped.copy_status, 'skipped');
	assert.equal(skipped.exported_file, '');
	assert.equal(skipped.copy_reason, 'collision');
	const [failed] = reconciliationRows(snapshot, [{ ...outcome, status: 'failed', reason: 'source-changed' }]);
	assert.equal(failed.copy_status, 'failed');
	assert.equal(failed.exported_file, '');
	assert.equal(failed.copy_reason, 'source-changed');
	assert.throws(() => reconciliationRows(snapshot, [outcome, outcome]), /saved approvals/);
	assert.throws(() => reconciliationRows(snapshot, [{ ...outcome, transactionId: second }]), /saved approvals/);
	assert.throws(() => reconciliationRows(snapshot, [{ ...outcome, documentId: randomUUID() }]), /saved approvals/);

	const reassigned = await saveWorkspace(snapshot, snapshot.metadata, snapshot.imports, snapshot.documentImports,
		new Map(snapshot.matchDecisions).set(first, replacement.id), snapshot.bankCorrections, snapshot.documentCorrections,
		new Map(snapshot.reviewApprovals).set(first, advanceReviewRevision(snapshot.reviewApprovals.get(first))));
	const [revoked] = reconciliationRows(reassigned);
	assert.equal(revoked.document_id, replacement.id);
	assert.equal(revoked.approval_status, 'revoked');
	assert.equal(revoked.approval_batch_id, '');
	assert.equal(revoked.approved_at, '');
	assert.equal(revoked.copy_status, 'not-eligible');
});

test('writes a fixed UTF-8 CSV header and escapes free text without changing exact decimal amounts', () => {
	const blank = Object.fromEntries(reconciliationCsvColumns.map(column => [column, ''])) as Parameters<typeof serializeReconciliationCsv>[0][number];
	const data = { ...blank, row_type: 'transaction', description: 'Café "Blue", Terrace\r\nSecond line', account_amount: '-9007199254740993.2700',
		original_amount: '0.0001', document_file: '  ＝1+1.pdf', copy_reason: '\t@note' };
	const header = reconciliationCsvColumns.join(',');
	assert.equal(serializeReconciliationCsv([]), '\uFEFF' + header + '\r\n');
	const output = serializeReconciliationCsv([data]);
	assert.deepEqual([...Buffer.from(output).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
	assert.ok(output.startsWith('\uFEFF' + header + '\r\ntransaction,'));
	assert.ok(output.includes('"Café ""Blue"", Terrace\r\nSecond line",-9007199254740993.2700,,0.0001,'));
	assert.ok(output.includes(",\"'  ＝1+1.pdf\","));
	assert.ok(output.includes(",\"'\t@note\",\r\n"));
	for (const description of ['=1+1', '+label', '-label', '@label', '\u200b=1+1', '\ntext']) {
		assert.ok(serializeReconciliationCsv([{ ...blank, description }]).includes(",\"'" + description + '",'), description);
	}
	assert.ok(serializeReconciliationCsv([{ ...blank, account_amount: '=1+1' }]).includes(",\"'=1+1\","));
});
