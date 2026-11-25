import type { TransactionCandidate } from '../src/shared/bank-import.js';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentExportOutcome, IDocumentExportReport } from '../src/shared/document-export.js';
import { renderExportFilename } from '../src/shared/export-filename.js';
import type { Money } from '../src/shared/money.js';
import type { MatchApproval } from '../src/shared/match-approvals.js';
import type { originalSourceExtensions } from '../src/shared/original-preview.js';
import type { DocumentFileResult, StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import { readSourceSnapshot } from './import/source.js';
import type { IOriginalSource } from './original-preview.js';

export interface IApprovedExportDocument {
	transactionId: string;
	documentId: string;
	date: string;
	counterparty: string | null;
	amount: Money;
	source: (IOriginalSource & Partial<Record<'relocatedPath', string>>) | null;
}

interface IExportOriginal extends Readonly<IOriginalSource> { readonly relocatedPath: string | undefined }
type ExportItem = Pick<DocumentExportOutcome, 'transactionId' | 'documentId' | 'sourceName' | 'sourcePath'>;
type RenderExportFilenameResult = ReturnType<typeof renderExportFilename>;

export function approvedExportDocuments(
	imports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[], approvals: ReadonlyMap<string, MatchApproval>,
	relocations?: ReadonlyMap<string, string>,
): IApprovedExportDocument[] {
	const originals: Map<string, IExportOriginal> = new Map(documentImports.flatMap((record: StoredDocumentImport): (readonly [string, IExportOriginal])[] =>
		record.files.flatMap((file: DocumentFileResult): [] | [readonly [string, IExportOriginal]] => file.status === 'imported' ? [[file.record.id, {
			filePath: file.record.filePath, format: file.record.format, sha256: file.record.result.input!.source.sha256,
			relocatedPath: relocations?.get(file.record.result.input!.source.sourceId),
		}] as const] : [])));
	const documents: IApprovedExportDocument[] = [];
	for (const record of imports) {
		const rows: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
		for (const { rowId, transactionId } of record.transactions) {
			const approval: MatchApproval | undefined = approvals.get(transactionId);
			if (!approval) {
				continue;
			}
			const row: TransactionCandidate = rows.get(rowId)!;
			const counterparty: string | undefined = row.counterpartyCandidate?.value.trim();
			documents.push({ transactionId, documentId: approval.documentId, date: row.bookingDate.value,
				counterparty: counterparty?.length ? counterparty : row.description.value.trim() || null,
				amount: row.accountAmount.value, source: originals.get(approval.documentId) ?? null });
		}
	}
	return documents;
}

export interface IExportDirectory {
	path: string;
	verify: () => Promise<void>;
}

interface IExportFilenameExtensions {
	readonly '.pdf': 'pdf';
	readonly '.png': 'png';
	readonly '.jpg': 'jpg';
	readonly '.jpeg': 'jpeg';
}

const extensions: typeof originalSourceExtensions = { pdf: ['.pdf'], png: ['.png'], jpeg: ['.jpg', '.jpeg'] } as const;
const filenames: IExportFilenameExtensions = { '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpeg' } as const;

export class ExportDestinationError extends Error {}

export function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}
export class ExportFileCleanupError extends Error {
	constructor(writeError: unknown) {
		super('An incomplete export file could not be removed.', { cause: writeError });
		this.code = errorCode(writeError);
	}

	readonly code: string | undefined;
}
function samePath(left: string, right: string): boolean {
	return path.relative(left, right) === '';
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function directoryIdentity(directory: string): Promise<BigIntStats> {
	const info: BigIntStats = await lstat(directory, { bigint: true });
	if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, await realpath(directory))) {
		throw new ExportDestinationError('Choose a regular export folder without linked paths.');
	}
	return info;
}

async function originalDirectoryIdentities(directory: string, sourcePaths: readonly string[]): Promise<BigIntStats[]> {
	const sourceParents: BigIntStats[] = [];
	for (const parent of new Set(sourcePaths.map((source: string): string => path.dirname(source)))) {
		const canonical: string = await realpath(parent).catch((): string => parent);
		if (samePath(directory, parent) || samePath(directory, canonical)) {
			throw new ExportDestinationError('Choose an export folder separate from the originals.');
		}
		const identity: BigIntStats | null = await stat(canonical, { bigint: true }).catch((): null => null);
		if (identity) {
			sourceParents.push(identity);
		}
	}
	return sourceParents;
}

async function verifiedDirectory(directory: string, sourceParents: readonly BigIntStats[], parent?: IExportDirectory): Promise<IExportDirectory> {
	const identity: BigIntStats = await directoryIdentity(directory);
	if (sourceParents.some((source: BigIntStats): boolean => sameFile(source, identity))) {
		throw new ExportDestinationError('Choose an export folder separate from the originals.');
	}
	const verify: () => Promise<void> = async (): Promise<void> => {
		await parent?.verify();
		if (!sameFile(identity, await directoryIdentity(directory))) {
			throw new ExportDestinationError('The export folder changed while exporting.');
		}
	};
	await verify();
	return { path: directory, verify };
}

export async function openExportDirectory(destination: string, sourcePaths: readonly string[] = []): Promise<IExportDirectory> {
	if (!path.isAbsolute(destination)) {
		throw new ExportDestinationError('Choose an absolute export folder.');
	}
	const directory: string = path.resolve(destination);
	try {
		return await verifiedDirectory(directory, await originalDirectoryIdentities(directory, sourcePaths));
	} catch (error: unknown) {
		if (error instanceof ExportDestinationError) {
			throw error;
		}
		throw new ExportDestinationError('The export folder could not be accessed.');
	}
}

async function prepareDirectory(destination: string | IExportDirectory, sourcePaths: readonly string[]): Promise<IExportDirectory> {
	const root: IExportDirectory = typeof destination === 'string' ? await openExportDirectory(destination, sourcePaths) : destination;
	const directory: string = path.join(root.path, 'documents');
	const sourceParents: BigIntStats[] = await originalDirectoryIdentities(directory, sourcePaths);
	await root.verify();
	try {
		await mkdir(directory);
	} catch (error: unknown) {
		if (errorCode(error) !== 'EEXIST') {
			throw error;
		}
	}
	return verifiedDirectory(directory, sourceParents, root);
}

async function removeOwnedFile(file: string, identity: BigIntStats): Promise<void> {
	const current: BigIntStats | null = await lstat(file, { bigint: true }).catch((error: unknown): null => {
		if (errorCode(error) !== 'ENOENT') {
			throw error;
		}
		return null;
	});
	if (current && !current.isSymbolicLink() && sameFile(current, identity)) {
		await unlink(file);
	}
}

async function removeAfterFailedWrite(file: string, identity: BigIntStats, writeError: unknown): Promise<never> {
	try {
		await removeOwnedFile(file, identity);
	} catch {
		throw new ExportFileCleanupError(writeError);
	}
	throw writeError;
}

async function writeExclusive(file: string, bytes: Uint8Array, verify: () => Promise<void>): Promise<BigIntStats> {
	const handle: FileHandle = await open(file, 'wx', 0o600);
	let identity: BigIntStats | undefined;
	try {
		try {
			const openedIdentity: BigIntStats = await handle.stat({ bigint: true });
			identity = openedIdentity;
			await verify();
			if (!sameFile(openedIdentity, await lstat(file, { bigint: true }))) {
				throw new Error('The export target changed while writing.');
			}
			await handle.writeFile(bytes);
			await handle.sync();
			await verify();
			if (!sameFile(openedIdentity, await lstat(file, { bigint: true }))) {
				throw new Error('The export target changed while writing.');
			}
			return openedIdentity;
		} finally {
			await handle.close();
		}
	} catch (error: unknown) {
		if (identity) {
			await removeAfterFailedWrite(file, identity, error);
		}
		throw error;
	}
}

export async function writeExportFile(directory: IExportDirectory, filename: string, bytes: Uint8Array): Promise<boolean> {
	if (!filename || filename === '.' || filename === '..' || path.basename(filename) !== filename) {
		throw new Error('The export filename is invalid.');
	}
	const { verify }: IExportDirectory = directory;
	await verify();
	const target: string = path.join(directory.path, filename);
	const temporary: string = path.join(directory.path, '.receiptmatch-' + randomUUID() + '.tmp');
	const identity: BigIntStats = await writeExclusive(temporary, bytes, verify);
	try {
		await verify();
		if (!sameFile(identity, await lstat(temporary, { bigint: true }))) {
			throw new Error('The export copy changed before publishing.');
		}
		let linked: boolean = false;
		try {
			await link(temporary, target); linked = true;
		} catch (error: unknown) {
			if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(errorCode(error) ?? '')) {
				throw error;
			}
			// Some removable media do not support hard links. Exclusive creation still prevents replacement.
			await verify();
			await writeExclusive(target, bytes, verify);
		}
		if (linked) {
			try {
				await verify();
				if (!sameFile(identity, await lstat(target, { bigint: true }))) {
					throw new Error('The export target changed before publishing.');
				}
			} catch (error: unknown) {
				await removeAfterFailedWrite(target, identity, error);
			}
		}
	} catch (error: unknown) {
		await removeAfterFailedWrite(temporary, identity, error);
	}
	return removeOwnedFile(temporary, identity).then((): boolean => false, (): boolean => true);
}

async function exportDocument(
	document: IApprovedExportDocument, directory: IExportDirectory, pattern: string,
): Promise<DocumentExportOutcome> {
	const { transactionId, documentId, source }: IApprovedExportDocument = document;
	const sourcePath: string | null = source?.relocatedPath ?? source?.filePath ?? null;
	const item: ExportItem = { transactionId, documentId, sourceName: sourcePath ? path.basename(sourcePath) : null, sourcePath };
	if (!source || !sourcePath) {
		return { ...item, status: 'failed', filename: null, reason: 'source-missing' };
	}
	const ext: string = path.extname(source.filePath).toLowerCase();
	if (!(extensions[source.format] as readonly string[]).includes(ext)) {
		return { ...item, status: 'failed', filename: null, reason: 'source-unreadable' };
	}
	const name: RenderExportFilenameResult = renderExportFilename(pattern, { ...document, extension: filenames[ext as keyof typeof filenames] });
	if (!name.filename) {
		return { ...item, status: 'failed', filename: null, reason: 'invalid-filename' };
	}
	const { filename }: Extract<RenderExportFilenameResult, Record<'filename', string>> = name;
	let bytes: Uint8Array;
	try {
		bytes = await readSourceSnapshot(sourcePath, extensions[source.format]);
	} catch (error: unknown) {
		const code: string | undefined = errorCode(error);
		return { ...item, status: 'failed', filename, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'source-missing' :
			code === 'source-changed' ? 'source-changed' : 'source-unreadable' };
	}
	if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
		return { ...item, status: 'failed', filename, reason: 'source-changed' };
	}
	try {
		const cleanupFailed: boolean = await writeExportFile(directory, filename, bytes);
		return { ...item, status: 'copied', filename, ...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) };
	} catch (error: unknown) {
		return errorCode(error) === 'EEXIST' ? { ...item, status: 'skipped', filename, reason: 'collision' } :
			{ ...item, status: 'failed', filename, reason: 'write-failed' };
	}
}

export async function copyApprovedDocuments(
	destination: string | IExportDirectory, pattern: string, documents: readonly IApprovedExportDocument[], sourcePaths: readonly string[],
): Promise<IDocumentExportReport> {
	if (!documents.length) {
		return { directory: null, outcomes: [] };
	}
	const originalPaths: string[] = [...sourcePaths, ...documents.flatMap(({ source }: IApprovedExportDocument): string[] =>
		source ? [source.filePath, ...(source.relocatedPath ? [source.relocatedPath] : [])] : [])];
	const directory: IExportDirectory = await prepareDirectory(destination, originalPaths).catch((error: unknown): never => {
		if (error instanceof ExportDestinationError) {
			throw error;
		}
		throw new ExportDestinationError('The export folder could not be created or accessed.');
	});
	const outcomes: DocumentExportOutcome[] = [];
	for (const document of documents) {
		outcomes.push(await exportDocument(document, directory, pattern));
	}
	return { directory: directory.path, outcomes };
}
