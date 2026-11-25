export type DocumentExportFailure = 'invalid-filename' | 'source-missing' | 'source-changed' | 'source-unreadable' | 'write-failed';

interface IDocumentExportItem {
	transactionId: string;
	documentId: string;
	sourceName: string | null;
	sourcePath: string | null;
}

interface ICopiedDocument { status: 'copied'; filename: string; warning?: 'temporary-cleanup-failed' }
interface ISkippedDocument { status: 'skipped'; filename: string; reason: 'collision' }
interface IFailedDocument { status: 'failed'; filename: string | null; reason: DocumentExportFailure }

export type DocumentExportOutcome = IDocumentExportItem & (ICopiedDocument | ISkippedDocument | IFailedDocument);

export interface IDocumentExportReport {
	directory: string | null;
	outcomes: DocumentExportOutcome[];
}

interface ICsvExportFile { filePath: string; warning?: 'temporary-cleanup-failed' }
interface IWrittenCsv { status: 'written' }
interface IFailedCsv { status: 'failed'; reason: 'collision' | 'write-failed' }

export interface IReconciliationExportReport {
	documentCopies: IDocumentExportReport;
	csv: ICsvExportFile & (IWrittenCsv | IFailedCsv);
}

interface ICompletedDocumentExport { status: 'completed'; report: IDocumentExportReport; csv?: IReconciliationExportReport['csv'] }
interface ICancelledDocumentExport { status: 'cancelled' }
interface IFailedDocumentExport { status: 'failed'; message: string }

export type DocumentExportResponse = ICompletedDocumentExport | ICancelledDocumentExport | IFailedDocumentExport;
