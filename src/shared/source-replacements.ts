import type { DocumentFileResult, StoredDocumentImport } from './workspace-documents.js';
import type { StoredBankImport } from './workspace-import.js';

export function activeStatements(imports: StoredBankImport[], replacements: ReadonlyMap<string, string>): StoredBankImport[] {
    return replacements.size ? imports.filter((record: StoredBankImport): boolean => !replacements.has(record.result.sourceProvenance!.sourceId)) : imports;
}

export function activeSupportingDocuments(imports: StoredDocumentImport[], replacements: ReadonlyMap<string, string>): StoredDocumentImport[] {
    if (!replacements.size) {
        return imports;
    }
    return imports.map((run: StoredDocumentImport): StoredDocumentImport => {
        const files: DocumentFileResult[] = run.files.filter((file: DocumentFileResult): boolean =>
            file.status !== 'imported' || !replacements.has(file.record.result.input!.source.sourceId));
        return files.length === run.files.length ? run : { ...run, files };
    });
}
