import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { defaultExportFilenamePattern, exportFilenameExample, renderExportFilename } from '../src/shared/export-filename.js';

export async function readExportFilenamePattern(file: string): Promise<string> {
	try {
		const stored: { filenamePattern?: unknown; } | null = JSON.parse(await readFile(file, 'utf8')) as { filenamePattern?: unknown } | null;
		const pattern: unknown = stored?.filenamePattern;
		return typeof pattern === 'string' && 'filename' in renderExportFilename(pattern, exportFilenameExample) ? pattern.trim() : defaultExportFilenamePattern;
	} catch (error: unknown) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
			return defaultExportFilenamePattern;
		}
		throw error;
	}
}

export async function saveExportFilenamePattern(file: string, pattern: string): Promise<string> {
	if ('error' in renderExportFilename(pattern, exportFilenameExample)) {
		throw new Error('Invalid export filename pattern.');
	}
	const filenamePattern: string = pattern.trim();
	const directory: string = path.dirname(file);
	const tempFile: string = path.join(directory, '.export-settings-' + randomUUID() + '.tmp');
	await mkdir(directory, { recursive: true });
	const handle: FileHandle = await open(tempFile, 'wx', 0o600);
	try {
		try {
			await handle.writeFile(JSON.stringify({ filenamePattern }) + '\n', 'utf8');
		} finally {
			await handle.close();
		}
		await rename(tempFile, file);
	} finally {
		await rm(tempFile, { force: true });
	}
	return filenamePattern;
}
