import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentExportOutcome, DocumentExportReport } from '../src/shared/document-export.js';
import { renderExportFilename } from '../src/shared/export-filename.js';
import type { Money } from '../src/shared/money.js';
import type { MatchApproval } from '../src/shared/match-approvals.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
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

export function approvedExportDocuments(
	imports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[], approvals: ReadonlyMap<string, MatchApproval>,
): ApprovedExportDocument[] {
	const originals = new Map(documentImports.flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [[file.record.id, {
		filePath: file.record.filePath, format: file.record.format, sha256: file.record.result.input!.source.sha256,
	}] as const] : [])));
	const documents: ApprovedExportDocument[] = [];
	for (const record of imports) {
		const rows = new Map(record.result.transactions.map(row => [row.rowId, row]));
		for (const { rowId, transactionId } of record.transactions) {
			const approval = approvals.get(transactionId);
			if (!approval) continue;
			const row = rows.get(rowId)!;
			documents.push({ transactionId, documentId: approval.documentId, date: row.bookingDate.value,
				counterparty: row.counterpartyCandidate?.value.trim() || row.description.value.trim() || null,
				amount: row.accountAmount.value, source: originals.get(approval.documentId) ?? null });
		}
	}
	return documents;
}

export interface ExportDirectory {
	path: string;
	verify(): Promise<void>;
}

const extensions = { pdf: ['.pdf'], png: ['.png'], jpeg: ['.jpg', '.jpeg'] } as const;
const filenames = { '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpeg' } as const;

export class ExportDestinationError extends Error {}

export function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
export class ExportFileCleanupError extends Error {
	readonly code: string | undefined;
	constructor(writeError: unknown) {
		super('An incomplete export file could not be removed.', { cause: writeError });
		this.code = errorCode(writeError);
	}
}
function samePath(left: string, right: string): boolean { return path.relative(left, right) === ''; }
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }

async function directoryIdentity(directory: string): Promise<BigIntStats> {
	const info = await lstat(directory, { bigint: true });
	if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, await realpath(directory))) {
		throw new ExportDestinationError('Choose a regular export folder without linked paths.');
	}
	return info;
}

async function originalDirectoryIdentities(directory: string, sourcePaths: readonly string[]): Promise<BigIntStats[]> {
	const sourceParents: BigIntStats[] = [];
	for (const parent of new Set(sourcePaths.map(source => path.dirname(source)))) {
		const canonical = await realpath(parent).catch(() => parent);
		if (samePath(directory, parent) || samePath(directory, canonical)) throw new ExportDestinationError('Choose an export folder separate from the originals.');
		const identity = await stat(canonical, { bigint: true }).catch(() => null);
		if (identity) sourceParents.push(identity);
	}
	return sourceParents;
}

async function verifiedDirectory(directory: string, sourceParents: readonly BigIntStats[], parent?: ExportDirectory): Promise<ExportDirectory> {
	const identity = await directoryIdentity(directory);
	if (sourceParents.some(source => sameFile(source, identity))) throw new ExportDestinationError('Choose an export folder separate from the originals.');
	const verify = async () => {
		await parent?.verify();
		if (!sameFile(identity, await directoryIdentity(directory))) throw new ExportDestinationError('The export folder changed while exporting.');
	};
	await verify();
	return { path: directory, verify };
}

export async function openExportDirectory(destination: string, sourcePaths: readonly string[] = []): Promise<ExportDirectory> {
	if (!path.isAbsolute(destination)) throw new ExportDestinationError('Choose an absolute export folder.');
	const directory = path.resolve(destination);
	try { return await verifiedDirectory(directory, await originalDirectoryIdentities(directory, sourcePaths)); }
	catch (error) {
		if (error instanceof ExportDestinationError) throw error;
		throw new ExportDestinationError('The export folder could not be accessed.');
	}
}

async function prepareDirectory(destination: string | ExportDirectory, sourcePaths: readonly string[]) {
	const root = typeof destination === 'string' ? await openExportDirectory(destination) : destination;
	const directory = path.join(root.path, 'documents');
	const sourceParents = await originalDirectoryIdentities(directory, sourcePaths);
	await root.verify();
	try { await mkdir(directory); }
	catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
	return verifiedDirectory(directory, sourceParents, root);
}

async function removeOwnedFile(file: string, identity: BigIntStats) {
	const current = await lstat(file, { bigint: true }).catch(error => {
		if (errorCode(error) !== 'ENOENT') throw error;
		return null;
	});
	if (current && !current.isSymbolicLink() && sameFile(current, identity)) await unlink(file);
}

async function removeAfterFailedWrite(file: string, identity: BigIntStats, writeError: unknown): Promise<never> {
	try { await removeOwnedFile(file, identity); }
	catch { throw new ExportFileCleanupError(writeError); }
	throw writeError;
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
		if (identity) await removeAfterFailedWrite(file, identity, error);
		throw error;
	}
}

export async function writeExportFile(directory: ExportDirectory, filename: string, bytes: Uint8Array): Promise<boolean> {
	if (!filename || filename === '.' || filename === '..' || path.basename(filename) !== filename) throw new Error('The export filename is invalid.');
	const { verify } = directory;
	await verify();
	const target = path.join(directory.path, filename);
	const temporary = path.join(directory.path, '.receiptmatch-' + randomUUID() + '.tmp');
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
				await removeAfterFailedWrite(target, identity, error);
			}
		}
	} catch (error) {
		await removeAfterFailedWrite(temporary, identity, error);
	}
	return removeOwnedFile(temporary, identity).then(() => false, () => true);
}

async function exportDocument(
	document: ApprovedExportDocument, directory: ExportDirectory, pattern: string,
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
		const cleanupFailed = await writeExportFile(directory, filename, bytes);
		return { ...item, status: 'copied', filename, ...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) };
	} catch (error) {
		return errorCode(error) === 'EEXIST' ? { ...item, status: 'skipped', filename, reason: 'collision' } :
			{ ...item, status: 'failed', filename, reason: 'write-failed' };
	}
}

export async function copyApprovedDocuments(
	destination: string | ExportDirectory, pattern: string, documents: readonly ApprovedExportDocument[], sourcePaths: readonly string[],
): Promise<DocumentExportReport> {
	if (!documents.length) return { directory: null, outcomes: [] };
	const originalPaths = [...sourcePaths, ...documents.flatMap(document => document.source ? [document.source.filePath] : [])];
	const directory = await prepareDirectory(destination, originalPaths).catch(error => {
		if (error instanceof ExportDestinationError) throw error;
		throw new ExportDestinationError('The export folder could not be created or accessed.');
	});
	const outcomes: DocumentExportOutcome[] = [];
	for (const document of documents) outcomes.push(await exportDocument(document, directory, pattern));
	return { directory: directory.path, outcomes };
}
