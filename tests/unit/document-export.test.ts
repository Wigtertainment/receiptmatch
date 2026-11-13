import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi, type TestContext } from 'vitest';
import { copyApprovedDocuments, type ApprovedExportDocument } from '../../electron/document-export.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { defaultExportFilenamePattern, exportFilenameExample } from '../../src/shared/export-filename.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

async function fixture(context: TestContext) {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'receiptmatch-document-export-'));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	const originals = path.join(root, 'originals', 'documents');
	const destination = path.join(root, 'destination');
	await Promise.all([fs.mkdir(originals, { recursive: true }), fs.mkdir(destination)]);
	return { root, originals, destination };
}

function approved(filePath: string, content: string, counterparty: string, format: 'pdf' | 'jpeg' = 'pdf'): ApprovedExportDocument {
	return { ...exportFilenameExample, transactionId: randomUUID(), documentId: randomUUID(), counterparty,
		source: { filePath, format, sha256: createHash('sha256').update(content).digest('hex') } };
}

test('exports only current approvals using effective bookings and leaves the workspace file untouched', async context => {
	const { root, originals, destination } = await fixture(context);
	const workspacePath = path.join(root, 'workspace.receiptmatch');
	const bank = retainedBank(root);
	const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
	const documents = [retainedDocument(originals, 'approved.pdf'), retainedDocument(originals, 'stale.pdf')];
	await Promise.all(documents.map(document => fs.writeFile(document.filePath, path.basename(document.filePath))));
	await createWorkspace(workspacePath, newMetadata(), [bank], [documentRun(originals, documents)], new Map([[first, documents[0].id], [second, documents[1].id]]));
	const before = await fs.readFile(workspacePath);
	const session = new WorkspaceSession({ open: async () => workspacePath, save: async () => workspacePath, unsaved: async () => 'discard' });
	assert.equal((await session.dispatch({ type: 'open' })).error, null);
	const workspace = () => session.state().workspace!;
	const selections = () => session.matchSummaries(workspace().matchRevision)!.map(row => row.approvalSelection!);
	const exportCurrent = () => session.exportApprovedDocuments(workspace().loadRevision, destination, defaultExportFilenamePattern);
	assert.deepEqual(await exportCurrent(), { directory: null, outcomes: [] });
	assert.deepEqual(await fs.readdir(destination), []);
	assert.equal((await session.dispatch({ type: 'correct-bank-row', revision: workspace().matchRevision, rowId: first,
		changes: { bookingDate: '2032-02-26' } })).error, null);
	assert.equal((await session.dispatch({ type: 'approve-matches', loadRevision: workspace().loadRevision, selections: selections() })).error, null);
	assert.equal((await session.dispatch({ type: 'correct-bank-row', revision: workspace().matchRevision, rowId: second,
		changes: { bookingDate: '2032-03-12' } })).error, null);
	await assert.rejects(session.exportApprovedDocuments(workspace().loadRevision + 1, destination, defaultExportFilenamePattern), /workspace changed/i);
	const pending = exportCurrent();
	await assert.rejects(exportCurrent(), /current workspace action/i);
	const directory = path.join(destination, 'documents');
	const filename = '2032-02-26_Orchard-Workshop_EUR_-1234.56.pdf';
	assert.deepEqual(await pending, { directory, outcomes: [{ transactionId: first, documentId: documents[0].id, sourceName: 'approved.pdf',
		sourcePath: documents[0].filePath, status: 'copied', filename }] });
	assert.deepEqual(await fs.readdir(directory), [filename]);
	assert.equal(await fs.readFile(path.join(directory, filename), 'utf8'), 'approved.pdf');
	assert.equal(await fs.readFile(documents[0].filePath, 'utf8'), 'approved.pdf');
	assert.deepEqual(await fs.readFile(workspacePath), before);
	assert.equal(workspace().dirty, true);
	assert.equal(session.state().busy, false);
});

test('reports collisions and source failures independently and preserves the JPEG extension', async context => {
	const { originals, destination } = await fixture(context);
	const first = approved(path.join(originals, 'first.pdf'), 'first', 'Same');
	const second = approved(path.join(originals, 'second.pdf'), 'second', 'Same');
	const changed = approved(path.join(originals, 'changed.pdf'), 'old', 'Changed');
	const missing = approved(path.join(originals, 'missing.pdf'), 'missing', 'Missing');
	const jpeg = approved(path.join(originals, 'photo.JPEG'), 'photo', 'Photo', 'jpeg');
	const documents = [first, second, changed, missing, jpeg];
	await Promise.all([fs.writeFile(first.source!.filePath, 'first'), fs.writeFile(second.source!.filePath, 'second'),
		fs.writeFile(changed.source!.filePath, 'new'), fs.writeFile(jpeg.source!.filePath, 'photo')]);
	const sources = documents.map(document => document.source!.filePath);
	const result = await copyApprovedDocuments(destination, '{counterparty}', documents, sources);
	assert.deepEqual(result.outcomes.map(outcome => [outcome.status, outcome.filename, 'reason' in outcome ? outcome.reason : null]), [
		['copied', 'Same.pdf', null], ['skipped', 'Same.pdf', 'collision'], ['failed', 'Changed.pdf', 'source-changed'],
		['failed', 'Missing.pdf', 'source-missing'], ['copied', 'Photo.jpeg', null],
	]);
	assert.equal(await fs.readFile(path.join(result.directory!, 'Same.pdf'), 'utf8'), 'first');
	assert.equal(await fs.readFile(path.join(result.directory!, 'Photo.jpeg'), 'utf8'), 'photo');
	const retry = await copyApprovedDocuments(destination, '{counterparty}', [second], sources);
	assert.equal(retry.outcomes[0].status, 'skipped');
	assert.deepEqual((await fs.readdir(result.directory!)).sort(), ['Photo.jpeg', 'Same.pdf']);
	assert.equal(await fs.readFile(path.join(result.directory!, 'Same.pdf'), 'utf8'), 'first');
});

test('rejects original directories and linked destinations, and leaves existing hard-linked files intact', async context => {
	const { originals, destination } = await fixture(context);
	const item = approved(path.join(originals, 'original.pdf'), 'original', 'Original');
	const source = item.source!.filePath;
	await fs.writeFile(source, 'original');
	await assert.rejects(copyApprovedDocuments(path.dirname(originals), '{counterparty}', [item], []), /separate from the originals/);
	const directory = path.join(destination, 'documents');
	await fs.symlink(originals, directory, 'junction');
	try { await assert.rejects(copyApprovedDocuments(destination, '{counterparty}', [item], [source]), /without linked paths/); }
	finally { await fs.unlink(directory); }
	await fs.mkdir(directory);
	const target = path.join(directory, 'Original.pdf');
	await fs.link(source, target);
	assert.equal((await copyApprovedDocuments(destination, '{counterparty}', [item], [source])).outcomes[0].status, 'skipped');
	assert.equal(await fs.readFile(target, 'utf8'), 'original');
	assert.equal(await fs.readFile(source, 'utf8'), 'original');
	assert.deepEqual(await fs.readdir(directory), ['Original.pdf']);
});

test('protects imported and relocated originals from use as a document export directory', async context => {
	const { root, originals, destination } = await fixture(context);
	const original = path.join(originals, 'original.pdf');
	const movedDirectory = path.join(destination, 'documents');
	const relocatedPath = path.join(movedDirectory, 'renamed.pdf');
	await fs.mkdir(movedDirectory);
	await fs.writeFile(relocatedPath, 'original');
	const item = approved(original, 'original', 'Relocated');
	item.source!.relocatedPath = relocatedPath;
	await assert.rejects(copyApprovedDocuments(originals, '{counterparty}', [item], []), /separate from the originals/);
	await assert.rejects(copyApprovedDocuments(movedDirectory, '{counterparty}', [item], []), /separate from the originals/);
	await assert.rejects(copyApprovedDocuments(path.dirname(originals), '{counterparty}', [item], []), /separate from the originals/);
	await assert.rejects(copyApprovedDocuments(destination, '{counterparty}', [item], []), /separate from the originals/);

	const permitted = path.join(root, 'permitted');
	await fs.mkdir(permitted);
	const result = await copyApprovedDocuments(permitted, '{counterparty}', [item], []);
	assert.equal(result.outcomes[0].sourcePath, relocatedPath);
	assert.equal(result.outcomes[0].status, 'copied');
	assert.equal(await fs.readFile(path.join(result.directory!, 'Relocated.pdf'), 'utf8'), 'original');
	assert.deepEqual(await fs.readdir(movedDirectory), ['renamed.pdf']);
});

test('removes an incomplete copy and keeps exporting after a write failure', async context => {
	const { originals, destination } = await fixture(context);
	const broken = approved(path.join(originals, 'broken.pdf'), 'broken', 'Broken');
	const healthy = approved(path.join(originals, 'healthy.pdf'), 'healthy', 'Healthy');
	const sources = [broken.source!.filePath, healthy.source!.filePath];
	await Promise.all([fs.writeFile(sources[0], 'broken'), fs.writeFile(sources[1], 'healthy')]);
	const realOpen = fs.open;
	const open = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
		const handle = await realOpen(file, flags, mode);
		if (String(file).endsWith('Broken.pdf')) {
			const write = handle.writeFile.bind(handle);
			vi.spyOn(handle, 'writeFile').mockImplementation(async () => { await write('partial'); throw new Error('Simulated write failure'); });
		}
		return handle;
	});
	const link = vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }));
	syncBuiltinESMExports();
	try {
		const result = await copyApprovedDocuments(destination, '{counterparty}', [broken, healthy], sources);
		assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['failed', 'copied']);
		assert.deepEqual(await fs.readdir(result.directory!), ['Healthy.pdf']);
		assert.equal(await fs.readFile(path.join(result.directory!, 'Healthy.pdf'), 'utf8'), 'healthy');
	} finally { link.mockRestore(); open.mockRestore(); syncBuiltinESMExports(); }
});
