import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentExportOutcome, DocumentExportReport } from '../src/shared/document-export.js';
import { renderExportFilename } from '../src/shared/export-filename.js';
import type { Money } from '../src/shared/money.js';
import { readSourceSnapshot } from './import/source.js';
import type { OriginalSource } from './original-preview.js';

export interface ApprovedExportDocument {
	transactionId: string;
	documentId: string;
	date: string;
	counterparty: string | null;
	amount: Money;
	source: OriginalSource | null;
}

const extensions = { pdf: ['.pdf'], png: ['.png'], jpeg: ['.jpg', '.jpeg'] } as const;
const filenames = { '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpeg' } as const;

export class ExportDestinationError extends Error {}

function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
function samePath(left: string, right: string): boolean { return path.relative(left, right) === ''; }
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }

async function directoryIdentity(directory: string): Promise<BigIntStats> {
	const info = await lstat(directory, { bigint: true });
	if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, await realpath(directory))) {
		throw new ExportDestinationError('Choose a regular export folder without linked paths.');
	}
	return info;
}

async function prepareDirectory(destination: string, sourcePaths: readonly string[]) {
	if (!path.isAbsolute(destination)) throw new ExportDestinationError('Choose an absolute export folder.');
	const root = path.resolve(destination);
	const rootIdentity = await directoryIdentity(root);
	const directory = path.join(root, 'documents');
	const sourceParents: BigIntStats[] = [];
	for (const parent of new Set(sourcePaths.map(source => path.dirname(source)))) {
		const canonical = await realpath(parent).catch(() => parent);
		if (samePath(directory, parent) || samePath(directory, canonical)) throw new ExportDestinationError('Choose an export folder separate from the originals.');
		const identity = await stat(canonical, { bigint: true }).catch(() => null);
		if (identity) sourceParents.push(identity);
	}
	if (!sameFile(rootIdentity, await directoryIdentity(root))) throw new ExportDestinationError('The export folder changed before copying documents.');
	try { await mkdir(directory); }
	catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
	const identity = await directoryIdentity(directory);
	if (!sameFile(rootIdentity, await directoryIdentity(root))) throw new ExportDestinationError('The export folder changed before copying documents.');
	if (sourceParents.some(parent => sameFile(parent, identity))) throw new ExportDestinationError('Choose an export folder separate from the originals.');
	return { directory, identity };
}

async function removeOwnedFile(file: string, identity: BigIntStats) {
	const current = await lstat(file, { bigint: true }).catch(error => {
		if (errorCode(error) !== 'ENOENT') throw error;
		return null;
	});
	if (current && !current.isSymbolicLink() && sameFile(current, identity)) await unlink(file);
}

async function writeExclusive(file: string, bytes: Uint8Array, verify: () => Promise<void>): Promise<BigIntStats> {
	const handle = await open(file, 'wx', 0o600);
	let identity: BigIntStats | undefined;
	try {
		try {
			identity = await handle.stat({ bigint: true });
			await verify();
			if (!sameFile(identity, await lstat(file, { bigint: true }))) throw new Error('The export target changed while writing.');
			await handle.writeFile(bytes);
			await handle.sync();
			await verify();
			if (!sameFile(identity, await lstat(file, { bigint: true }))) throw new Error('The export target changed while writing.');
		} finally { await handle.close(); }
		return identity;
	} catch (error) {
		if (identity) await removeOwnedFile(file, identity);
		throw error;
	}
}

async function copyExclusive(directory: string, target: string, bytes: Uint8Array, verify: () => Promise<void>) {
	await verify();
	const temporary = path.join(directory, '.receiptmatch-' + randomUUID() + '.tmp');
	const identity = await writeExclusive(temporary, bytes, verify);
	try {
		await verify();
		if (!sameFile(identity, await lstat(temporary, { bigint: true }))) throw new Error('The export copy changed before publishing.');
		let linked = false;
		try { await link(temporary, target); linked = true; }
		catch (error) {
			if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(errorCode(error) ?? '')) throw error;
			// Some removable media do not support hard links. Exclusive creation still prevents replacement.
			await verify();
			await writeExclusive(target, bytes, verify);
		}
		if (linked) {
			try {
				await verify();
				if (!sameFile(identity, await lstat(target, { bigint: true }))) throw new Error('The export target changed before publishing.');
			} catch (error) {
				await removeOwnedFile(target, identity);
				throw error;
			}
		}
	} catch (error) {
		await removeOwnedFile(temporary, identity);
		throw error;
	}
	return removeOwnedFile(temporary, identity).then(() => false, () => true);
}

async function exportDocument(
	document: ApprovedExportDocument, directory: string, pattern: string, verify: () => Promise<void>,
): Promise<DocumentExportOutcome> {
	const { transactionId, documentId, source } = document;
	const item = { transactionId, documentId, sourceName: source ? path.basename(source.filePath) : null, sourcePath: source?.filePath ?? null };
	if (!source) return { ...item, status: 'failed', filename: null, reason: 'source-missing' };
	const ext = path.extname(source.filePath).toLowerCase();
	if (!(extensions[source.format] as readonly string[]).includes(ext)) return { ...item, status: 'failed', filename: null, reason: 'source-unreadable' };
	const name = renderExportFilename(pattern, { ...document, extension: filenames[ext as keyof typeof filenames] });
	if (!name.filename) return { ...item, status: 'failed', filename: null, reason: 'invalid-filename' };
	const { filename } = name;
	let bytes: Uint8Array;
	try { bytes = await readSourceSnapshot(source.filePath, extensions[source.format]); }
	catch (error) {
		const code = errorCode(error);
		return { ...item, status: 'failed', filename, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'source-missing' :
			code === 'source-changed' ? 'source-changed' : 'source-unreadable' };
	}
	if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) return { ...item, status: 'failed', filename, reason: 'source-changed' };
	try {
		const cleanupFailed = await copyExclusive(directory, path.join(directory, filename), bytes, verify);
		return { ...item, status: 'copied', filename, ...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) };
	} catch (error) {
		return errorCode(error) === 'EEXIST' ? { ...item, status: 'skipped', filename, reason: 'collision' } :
			{ ...item, status: 'failed', filename, reason: 'write-failed' };
	}
}

export async function copyApprovedDocuments(
	destination: string, pattern: string, documents: readonly ApprovedExportDocument[], sourcePaths: readonly string[],
): Promise<DocumentExportReport> {
	if (!documents.length) return { directory: null, outcomes: [] };
	const originalPaths = [...sourcePaths, ...documents.flatMap(document => document.source ? [document.source.filePath] : [])];
	const { directory, identity } = await prepareDirectory(destination, originalPaths).catch(error => {
		if (error instanceof ExportDestinationError) throw error;
		throw new ExportDestinationError('The export folder could not be created or accessed.');
	});
	const verify = async () => {
		if (!sameFile(identity, await directoryIdentity(directory))) throw new Error('The export directory changed while copying documents.');
	};
	const outcomes: DocumentExportOutcome[] = [];
	for (const document of documents) outcomes.push(await exportDocument(document, directory, pattern, verify));
	return { directory, outcomes };
}
