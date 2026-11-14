import type { StoredSupportingDocument } from "./workspace-documents.js";
import type { ImportIssue } from "./bank-import.js";
import type { SupportingDocument } from "./supporting-document.js";
import type { StoredDocumentImport } from './workspace-documents.js';
import type { StoredBankImport } from './workspace-import.js';

export function activeStatements(imports: StoredBankImport[], replacements: ReadonlyMap<string, string>): StoredBankImport[] {
    return replacements.size ? imports.filter((record: StoredBankImport): boolean => !replacements.has(record.result.sourceProvenance!.sourceId)) : imports;
}

export function activeSupportingDocuments(imports: StoredDocumentImport[], replacements: ReadonlyMap<string, string>): StoredDocumentImport[] {
    if (!replacements.size) {
        return imports;
    }
    return imports.map((run: StoredDocumentImport): StoredDocumentImport => {
        const files: ({ status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "pdf" | "png" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; })[] = run.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "pdf" | "png" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): boolean => file.status !== 'imported' || !replacements.has(file.record.result.input!.source.sourceId));
        return files.length === run.files.length ? run : { ...run, files };
    });
}
