import type { StoredBankImport } from "../src/shared/workspace-import.js";
import type { MatchApproval } from "../src/shared/match-approvals.js";
import type { DocumentExportReport } from "../src/shared/document-export.js";
import type { WorkspaceSource } from "../src/shared/workspace-documents.js";
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { applyBankCorrections } from '../src/shared/bank-corrections.js';
import type { ReconciliationExportReport } from '../src/shared/document-export.js';
import { currentMatchApprovals, documentRevisionIndex } from '../src/shared/match-approvals.js';
import { excludeDuplicateTransactions } from '../src/shared/transaction-duplicates.js';
import { activeStatements, activeSupportingDocuments } from '../src/shared/source-replacements.js';
import {
	approvedExportDocuments, copyApprovedDocuments, errorCode, ExportDestinationError, ExportFileCleanupError, openExportDirectory, writeExportFile,
	type ApprovedExportDocument, type ExportDirectory,
} from './document-export.js';
import { reconciliationRows, serializeReconciliationCsv } from './reconciliation-csv.js';
import type { SavedWorkspace } from './store.js';

const filename: "reconciliation.csv" = 'reconciliation.csv';

export async function writeReconciliationExport(snapshot: SavedWorkspace, destination: string, pattern: string): Promise<ReconciliationExportReport> {
	const sources: string[] = [...snapshot.sources.map((source: WorkspaceSource): string => source.filePath), ...snapshot.sourceRelocations.values()];
	const directory: ExportDirectory = await openExportDirectory(destination, sources);
	const filePath: string = path.join(directory.path, filename);
	const exists: boolean = await lstat(filePath).then((): boolean => true, (error: unknown): boolean => {
		if (errorCode(error) === 'ENOENT') {
			return false;
		}
		throw new ExportDestinationError('The CSV destination could not be checked.');
	});
	if (exists) {
		throw new ExportDestinationError('reconciliation.csv already exists. Choose another export folder.');
	}

	const imports: StoredBankImport[] = excludeDuplicateTransactions(activeStatements(applyBankCorrections(snapshot.imports, snapshot.bankCorrections), snapshot.sourceReplacements), snapshot.duplicateDecisions.values());
	const revisions: Map<string, number> = documentRevisionIndex(snapshot.documentCorrections.values());
	const approvals: Map<string, MatchApproval> = currentMatchApprovals(snapshot.reviewApprovals, snapshot.matchDecisions, snapshot.bankCorrections, revisions);
	for (const id of snapshot.ignoredTransactions) {
		approvals.delete(id);
	}
	const documents: ApprovedExportDocument[] = approvedExportDocuments(imports, activeSupportingDocuments(snapshot.documentImports, snapshot.sourceReplacements), approvals, snapshot.sourceRelocations);
	const documentCopies: DocumentExportReport = await copyApprovedDocuments(directory, pattern, documents, sources);
	try {
		const csv: string = serializeReconciliationCsv(reconciliationRows(snapshot, documentCopies.outcomes));
		const cleanupFailed: boolean = await writeExportFile(directory, filename, Buffer.from(csv, 'utf8'));
		return { documentCopies, csv: { filePath, status: 'written', ...(cleanupFailed ? { warning: 'temporary-cleanup-failed' } : {}) } };
	} catch (error: unknown) {
		return { documentCopies, csv: { filePath, status: 'failed', reason: errorCode(error) === 'EEXIST' ? 'collision' : 'write-failed',
			...(error instanceof ExportFileCleanupError ? { warning: 'temporary-cleanup-failed' } : {}) } };
	}
}
