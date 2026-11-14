import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileReadResult, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PDF_EXTRACTION_LIMITS } from "../../src/shared/pdf-extraction.js";

export class SourceReadError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
export function assertSourceNotCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new SourceReadError("cancelled", "Document import was cancelled.");
	}
}

function sameRevision(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function readSourceSnapshot(filePath: string, allowedExtensions: readonly string[], signal?: AbortSignal, expectedRevision?: BigIntStats): Promise<Uint8Array> {
	if (!path.isAbsolute(filePath) || !allowedExtensions.includes(path.extname(filePath).toLowerCase()) || filePath.length > 32768 || filePath.includes("\0")) {
		throw new SourceReadError("invalid-source", "Choose an absolute local file with a supported document extension.");
	}
	assertSourceNotCancelled(signal);
	const selected: BigIntStats = await lstat(filePath, { bigint: true });
	if (!selected.isFile() || selected.isSymbolicLink()) {
		throw new SourceReadError("invalid-source", "Choose a regular document rather than a directory or linked file.");
	}
	if (expectedRevision && !sameRevision(expectedRevision, selected)) {
			throw new SourceReadError("source-changed", "The selected file changed before it could be read. Choose it again.");
		}
	const file: FileHandle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const before: BigIntStats = await file.stat({ bigint: true });
		if (!before.isFile() || !sameRevision(selected, before) || (expectedRevision && !sameRevision(expectedRevision, before))) {
			throw new SourceReadError("source-changed", "The selected file changed before it could be read. Choose it again.");
		}
		if (before.size < 1n || before.size > BigInt(PDF_EXTRACTION_LIMITS.bytes)) {
				throw new SourceReadError("source-limit", "The selected file is empty or exceeds the local extraction byte limit.");
			}
		const bytes: Buffer<ArrayBuffer> = Buffer.alloc(Number(before.size));
		let position: number = 0;
		while (position < bytes.length) {
			assertSourceNotCancelled(signal);
			const { bytesRead }: FileReadResult<Buffer<ArrayBuffer>> = await file.read(bytes, position, Math.min(65536, bytes.length - position), position);
			if (!bytesRead) {
				throw new SourceReadError("source-changed", "The selected file changed while it was being read. Choose it again.");
			}
			position += bytesRead;
		}
		assertSourceNotCancelled(signal);
		const extra: FileReadResult<Buffer<ArrayBuffer>> = await file.read(Buffer.alloc(1), 0, 1, position),
			after: BigIntStats = await file.stat({ bigint: true }),
			currentPath: BigIntStats = await lstat(filePath, { bigint: true });
		if (extra.bytesRead || !currentPath.isFile() || currentPath.isSymbolicLink() || !sameRevision(before, after) || !sameRevision(before, currentPath)) {
			throw new SourceReadError("source-changed", "The selected file changed while it was being read. Choose it again.");
		}
		assertSourceNotCancelled(signal);
		return bytes;
	} finally {
		await file.close();
	}
}
