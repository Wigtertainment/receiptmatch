import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { applyBankCorrections } from '../src/shared/bank-corrections.js';
import type { ReconciliationExportReport } from '../src/shared/document-export.js';
import { currentMatchApprovals, documentRevisionIndex } from '../src/shared/match-approvals.js';
import { excludeDuplicateTransactions } from '../src/shared/transaction-duplicates.js';
import { activeStatements, activeSupportingDocuments } from '../src/shared/source-replacements.js';
import {
	approvedExportDocuments, copyApprovedDocuments, errorCode, ExportDestinationError, ExportFileCleanupError, openExportDirectory, writeExportFile,
} from './document-export.js';
import { reconciliationRows, serializeReconciliationCsv } from './reconciliation-csv.js';
import type { SavedWorkspace } from './store.js';

const filename = 'reconciliation.csv';

export async function writeReconciliationExport(snapshot: SavedWorkspace, destination: string, pattern: string): Promise<ReconciliationExportReport> {
	const sources = [...snapshot.sources.map(source => source.filePath), ...snapshot.sourceRelocations.values()];
	const directory = await openExportDirectory(destination, sources);
	const filePath = path.join(directory.path, filename);
	const exists = await lstat(filePath).then(() => true, error => {
		if (errorCode(error) === 'ENOENT') return false;
		throw new ExportDestinationError('The CSV destination could not be checked.');
	});
	if (exists) throw new ExportDestinationError('reconciliation.csv already exists. Choose another export folder.');

	const imports = excludeDuplicateTransactions(activeStatements(applyBankCorrections(snapshot.imports, snapshot.bankCorrections), snapshot.sourceReplacements), snapshot.duplicateDecisions.values());
	const revisions = documentRevisionIndex(snapshot.documentCorrections.values());
	const approvals = currentMatchApprovals(snapshot.reviewApprovals, snapshot.matchDecisions, snapshot.bankCorrections, revisions);
	for (const id of snapshot.ignoredTransactions) approvals.delete(id);
	const documents = approvedExportDocuments(imports, activeSupportingDocuments(snapshot.documentImports, snapshot.sourceReplacements), approvals, snapshot.sourceRelocations);
	const documentCopies = await copyApprovedDocuments(directory, pattern, documents, sources);
	try {
		const csv = serializeReconciliationCsv(reconciliationRows(snapshot, documentCopies.outcomes));
		const cleanupFailed = await writeExportFile(directory, filename, Buffer.from(csv, 'utf8'));
		return { documentCopies, csv: { filePath, status: 'written', ...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) } };
	} catch (error) {
		return { documentCopies, csv: { filePath, status: 'failed', reason: errorCode(error) === 'EEXIST' ? 'collision' : 'write-failed',
			...(error instanceof ExportFileCleanupError ? { warning: 'temporary-cleanup-failed' } : {}) } };
	}
}
