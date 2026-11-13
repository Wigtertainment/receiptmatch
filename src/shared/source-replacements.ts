import type { StoredDocumentImport } from './workspace-documents.js';
import type { StoredBankImport } from './workspace-import.js';

export function activeStatements(imports: StoredBankImport[], replacements: ReadonlyMap<string, string>): StoredBankImport[] {
    return replacements.size ? imports.filter(record => !replacements.has(record.result.sourceProvenance!.sourceId)) : imports;
}

export function activeSupportingDocuments(imports: StoredDocumentImport[], replacements: ReadonlyMap<string, string>): StoredDocumentImport[] {
    if (!replacements.size) return imports;
    return imports.map(run => {
        const files = run.files.filter(file => file.status !== 'imported' || !replacements.has(file.record.result.input!.source.sourceId));
        return files.length === run.files.length ? run : { ...run, files };
    });
}
