import { z } from 'zod';

export const workspaceName = z.string().max(120);
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-state') }),
  z.strictObject({ type: z.literal('new') }),
  z.strictObject({ type: z.literal('open') }),
  z.strictObject({ type: z.literal('save') }),
  z.strictObject({ type: z.literal('rename'), name: workspaceName })
]);
export type WorkspaceCommand = z.infer<typeof commandSchema>;
export interface WorkspaceView { id: string; name: string; filePath: string | null; dirty: boolean; savedAt: string | null; }
export interface WorkspaceState { workspace: WorkspaceView | null; busy: boolean; error: string | null; }
export interface WorkspaceBridge { command(value: WorkspaceCommand): Promise<WorkspaceState>; subscribe(listener: (state: WorkspaceState) => void): () => void; }
