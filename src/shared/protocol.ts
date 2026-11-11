import { z } from 'zod';
import type { ExtractionProgress } from './pdf-extraction.js';
import type { BankImportSummary, StoredBankImport } from './workspace-import.js';
import type { ImportIssue } from './bank-import.js';
import type { DocumentImportProgress, StoredDocumentImport } from './workspace-documents.js';

export const workspaceName = z.string().max(120);
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-state') }),
  z.strictObject({ type: z.literal('new') }),
  z.strictObject({ type: z.literal('open') }),
  z.strictObject({ type: z.literal('save') }),
  z.strictObject({ type: z.literal('import-statement') }),
  z.strictObject({ type: z.literal('import-documents') }),
  z.strictObject({ type: z.literal('cancel-import') }),
  z.strictObject({ type: z.literal('rename'), name: workspaceName })
]);
export type WorkspaceCommand = z.infer<typeof commandSchema>;
export interface DocumentImportSummary { id: string; folderPath: string; status: 'finished' | 'cancelled'; imported: number; skipped: number; failed: number; unsupported: number; directoryIssues: number; }
export interface WorkspaceView { id: string; loadRevision: number; name: string; filePath: string | null; dirty: boolean; savedAt: string | null; imports: BankImportSummary[]; documentImports: DocumentImportSummary[]; }
export interface ImportOutcome { status: 'imported' | 'skipped' | 'cancelled' | 'failed' | 'unsupported'; importId: string | null; issues: ImportIssue[]; }
export interface WorkspaceState {
  workspace: WorkspaceView | null;
  busy: boolean;
  error: string | null;
  statementImport: { cancelling: boolean; progress: ExtractionProgress | null } | null;
  importOutcome: ImportOutcome | null;
  documentImport: { cancelling: boolean; progress: DocumentImportProgress | null } | null;
  documentOutcome: { status: 'finished' | 'cancelled' | 'failed'; importId: string | null; issues: ImportIssue[] } | null;
}
export interface WorkspaceBridge {
  command(value: WorkspaceCommand): Promise<WorkspaceState>;
  bankImports(): Promise<StoredBankImport[]>;
  documentImports(): Promise<StoredDocumentImport[]>;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
}
