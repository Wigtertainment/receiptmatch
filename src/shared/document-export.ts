export type DocumentExportFailure = 'invalid-filename' | 'source-missing' | 'source-changed' | 'source-unreadable' | 'write-failed';

interface DocumentExportItem {
	transactionId: string;
	documentId: string;
	sourceName: string | null;
	sourcePath: string | null;
}

export type DocumentExportOutcome = DocumentExportItem & (
	| { status: 'copied'; filename: string; warning?: 'temporary-cleanup-failed' }
	| { status: 'skipped'; filename: string; reason: 'collision' }
	| { status: 'failed'; filename: string | null; reason: DocumentExportFailure }
);

export interface DocumentExportReport {
	directory: string | null;
	outcomes: DocumentExportOutcome[];
}

export interface ReconciliationExportReport {
	documentCopies: DocumentExportReport;
	csv: { filePath: string; warning?: 'temporary-cleanup-failed' } & (
		| { status: 'written' }
		| { status: 'failed'; reason: 'collision' | 'write-failed' }
	);
}

export type DocumentExportResponse =
	| { status: 'completed'; report: DocumentExportReport; csv?: ReconciliationExportReport['csv'] }
	| { status: 'cancelled' }
	| { status: 'failed'; message: string };
