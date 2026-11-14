import type { BankImportInput, ImportIssue, PositionedSpan } from "../../src/shared/bank-import.js";
import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { WorkspaceView } from "../../src/shared/protocol.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import { test, vi, type Mock } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { importIssue } from '../../src/shared/bank-import.js';
import { PDF_EXTRACTION_LIMITS, PDF_EXTRACTION_VERSION, type ExtractionProgress, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import { storedBankImportSchema, type BankImportRunResult } from '../../src/shared/workspace-import.js';
import { StatementImportService, type BankImportOptions, type BankImportService } from '../../electron/import/service.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import { createWorkspace, fingerprint, loadWorkspace, newMetadata } from '../../electron/store.js';
import { row, statement } from './bank-fixtures.js';
import type { ReadOptionsWithBuffer } from 'node:fs';
import type { ReadOptions } from 'node:fs';
import type { ReadPosition } from 'node:fs';
import type { Mode } from 'node:fs';
import type { PathLike } from 'node:fs';

async function fixtures(): Promise<{ directory: string; source: string; }> {
    await mkdir('artifacts', { recursive: true });
    const directory: string = await mkdtemp(path.resolve('artifacts/import-unit-'));
    const source: string = path.join(directory, 'synthetic.pdf');
    await writeFile(source, 'Independently invented PDF transport fixture; extraction is injected for service unit tests.');
    return { directory, source };
}

function extracted(bytes: Uint8Array, sourceId: string, partial: boolean = false): ExtractionResult {
    const input: BankImportInput = statement();
    input.source = { sourceId, sha256: createHash('sha256').update(bytes).digest('hex') };
    input.extraction = { runId: randomUUID(), version: PDF_EXTRACTION_VERSION };
    if (partial) {
        input.pages[0].spans.push(...row(350, '31 Feb 2032', 'Synthetic unresolved row', '2.00', null));
    }
    return { status: 'complete', input };
}

function dialogs(): { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } {
    const plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ('save' | 'discard' | 'cancel')[] } = { saves: [], opens: [], choices: [] };
    const handlers: WorkspaceDialogs = {
        save: async (): Promise<string | null> => Promise.resolve(plan.saves.shift() ?? null),
        open: async (): Promise<string | null> => Promise.resolve(plan.opens.shift() ?? null),
        unsaved: async (): Promise<"discard" | "save" | "cancel"> => Promise.resolve(plan.choices.shift() ?? 'cancel')
    };
    return { plan, handlers };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let count: number = 0; count < 100; count++) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve: (value: unknown) => void): NodeJS.Timeout => setTimeout(resolve, 5));
    }
    assert.fail('The controlled asynchronous import did not reach its expected boundary.');
}

test('service retains exact valid rows and unresolved drafts with stable host-owned maps; identical bytes skip before extraction', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    const original: string = await fingerprint(source);
    let calls: number = 0;
    const service: StatementImportService = new StatementImportService({
        choose: async (): Promise<string> => Promise.resolve(source),
        extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => {
            calls++;
            return Promise.resolve(extracted(bytes, id, true));
        }
    });
    const imported: BankImportRunResult = await service.run({ existing: [] });
    assert.equal(imported.status, 'imported');
    if (imported.status !== 'imported') {
        return;
    }
    const record: StoredBankImport = imported.record;
    assert.equal(storedBankImportSchema.safeParse(record).success, true);
    assert.equal(record.result.status, 'partial');
    assert.equal(record.transactions.length, 2);
    assert.equal(record.drafts.length, 1);
    assert.equal(record.accounts.length, 1);
    assert.equal(record.result.transactions[0].accountAmount.value.coefficient, '-123456');
    assert.equal(record.result.sourceProvenance?.sha256, original);
    assert.equal(z.uuid().safeParse(record.result.sourceProvenance?.sourceId).success, true);
    assert.equal(record.result.unresolvedDrafts[0].bookingDate, null);
    assert.ok(record.result.unresolvedDrafts[0].issues.length);
    const again: BankImportRunResult = await service.run({ existing: [record] });
    assert.deepEqual(again, { status: 'skipped', importId: record.id });
    assert.equal(calls, 1);
    const alias: string = path.join(directory, 'same-content.pdf');
    await writeFile(alias, await readFile(source));
    const otherPath: StatementImportService = new StatementImportService({
        choose: async (): Promise<string> => Promise.resolve(alias),
        extract: async (): Promise<never> => {
            return Promise.resolve().then((): never => assert.fail('Duplicate bytes reached extraction.'));
        }
    });
    assert.deepEqual(await otherPath.run({ existing: [record] }), { status: 'skipped', importId: record.id });
    assert.equal(await fingerprint(source), original);
});

test('service rejects invalid extraction provenance, unsupported layouts and read limits without inventing financial records', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    for (const fault of ['source', 'hash', 'run', 'version', 'bank']) {
        const service: StatementImportService = new StatementImportService({
            choose: async (): Promise<string> => Promise.resolve(source),
            extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; }> => {
                const result: ReturnType<typeof extracted> = extracted(bytes, id);
                assert.equal(result.status, 'complete');
                if (result.status !== 'complete') {
                    return Promise.resolve(result);
                }
                if (fault === 'source') {
                    result.input.source.sourceId = randomUUID();
                }
                if (fault === 'hash') {
                    result.input.source.sha256 = 'b'.repeat(64);
                }
                if (fault === 'run') {
                    result.input.extraction.runId = 'not-a-host-run';
                }
                if (fault === 'version') {
                    result.input.extraction.version = 'unrecognized-engine';
                }
                if (fault === 'bank') {
                    result.input.pages[0].spans.find((span: PositionedSpan): boolean => span.text.startsWith('Revolut'))!.text = 'Unrecognized bank';
                }
                return Promise.resolve(result);
            }
        });
        const outcome: BankImportRunResult = await service.run({ existing: [] });
        assert.equal(outcome.status, fault === 'bank' ? 'unsupported' : 'failed', fault);
    }
    const oversized: string = path.join(directory, 'oversized.pdf');
    const descriptor: fsPromises.FileHandle = await open(oversized, 'w');
    try {
        await descriptor.truncate(PDF_EXTRACTION_LIMITS.bytes + 1);
    } finally {
        await descriptor.close();
    }
    const empty: string = path.join(directory, 'empty.pdf');
    await writeFile(empty, '');
    const folder: string = path.join(directory, 'folder.pdf');
    await mkdir(folder);
    for (const selected of [oversized, empty, folder, 'relative.pdf', path.join(directory, 'absent.pdf')]) {
        const service: StatementImportService = new StatementImportService({
            choose: async (): Promise<string> => Promise.resolve(selected),
            extract: async (): Promise<never> => {
                return Promise.resolve().then((): never => assert.fail('Invalid source reached extraction.'));
            }
        });
        assert.equal((await service.run({ existing: [] })).status, 'failed');
    }
});

test('service detects file growth during bounded reads and never passes an unstable snapshot to extraction', async (): Promise<void> => {
    const { source }: { directory: string; source: string; } = await fixtures();
    const originalOpen: (path: PathLike, flags?: string | number, mode?: Mode) => Promise<fsPromises.FileHandle> = fsPromises.open;
    let changed: boolean = false;
    let restoreRead: (() => void) | undefined;
    const probe: Mock<(path: PathLike, flags?: string | number, mode?: Mode) => Promise<fsPromises.FileHandle>> = vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof fsPromises.open>): Promise<fsPromises.FileHandle> => {
        const file: fsPromises.FileHandle = await originalOpen(...args);
        if (args[0] === source) {
            const read: { <T extends NodeJS.ArrayBufferView>(buffer: T, offset?: number | null, length?: number | null, position?: ReadPosition | null): Promise<fsPromises.FileReadResult<T>>; <T extends NodeJS.ArrayBufferView>(buffer: T, options?: ReadOptions): Promise<fsPromises.FileReadResult<T>>; <T extends NodeJS.ArrayBufferView = NonSharedBuffer>(options?: ReadOptionsWithBuffer<T>): Promise<fsPromises.FileReadResult<T>>; } = file.read.bind(file);
            const readProbe: Mock<{ <T extends NodeJS.ArrayBufferView>(buffer: T, offset?: number | null, length?: number | null, position?: ReadPosition | null): Promise<fsPromises.FileReadResult<T>>; <T extends NodeJS.ArrayBufferView>(buffer: T, options?: ReadOptions): Promise<fsPromises.FileReadResult<T>>; <T extends NodeJS.ArrayBufferView = NonSharedBuffer>(options?: ReadOptionsWithBuffer<T>): Promise<fsPromises.FileReadResult<T>>; }> = vi.spyOn(file, 'read').mockImplementation((async (...readArgs: Parameters<typeof file.read>): Promise<fsPromises.FileReadResult<NodeJS.ArrayBufferView>> => {
                const result: fsPromises.FileReadResult<NodeJS.ArrayBufferView> = await read(...readArgs);
                if (!changed) {
                    changed = true;
                    await fsPromises.appendFile(source, 'External synthetic change');
                }
                return result;
            }));
            restoreRead = (): void => readProbe.mockRestore();
        }
        return file;
    }));
    syncBuiltinESMExports();
    try {
        const service: StatementImportService = new StatementImportService({
            choose: async (): Promise<string> => Promise.resolve(source),
            extract: async (): Promise<never> => {
                return Promise.resolve().then((): never => assert.fail('An unstable snapshot reached extraction.'));
            }
        });
        const result: BankImportRunResult = await service.run({ existing: [] });
        assert.equal(changed, true);
        assert.equal(result.status, 'failed');
        if (result.status === 'failed') {
            assert.equal(result.issues[0].code, 'source-changed');
        }
    } finally {
        restoreRead?.();
        probe.mockRestore();
        syncBuiltinESMExports();
    }
});

test('import/save/reopen preserves full records and stable IDs; loaded-byte duplicates stay clean and distinct sources are not amount-merged', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    const { plan, handlers }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
    let calls: number = 0;
    const service: StatementImportService = new StatementImportService({
        choose: async (): Promise<string> => Promise.resolve(source),
        extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => {
            calls++;
            return Promise.resolve(extracted(bytes, id, true));
        }
    });
    const session: WorkspaceSession = new WorkspaceSession(handlers, undefined, service);
    await session.dispatch({ type: 'new' });
    await session.dispatch({ type: 'rename', name: 'Synthetic import workspace' });
    const file: string = path.join(directory, 'local.receiptmatch');
    plan.saves.push(file);
    await session.dispatch({ type: 'save' });
    const savedHash: string = await fingerprint(file);
    await session.dispatch({ type: 'import-statement' });
    assert.equal(session.state().workspace?.dirty, true);
    assert.equal(session.state().importOutcome?.status, 'imported');
    assert.equal(session.state().workspace?.imports[0].drafts, 1);
    assert.equal(await fingerprint(file), savedHash, 'Import must not implicitly save workspace data.');
    const report: StoredBankImport[] = session.bankImports();
    report[0].result.transactions[0].accountAmount.value.coefficient = '999';
    assert.equal(session.bankImports()[0].result.transactions[0].accountAmount.value.coefficient, '-123456');
    const stateCopy: WorkspaceState = session.state();
    stateCopy.workspace!.imports[0].transactions = 999;
    assert.equal(session.state().workspace!.imports[0].transactions, 2);
    const expected: StoredBankImport[] = session.bankImports();
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual((await loadWorkspace(file)).imports, expected);
    const reopened: WorkspaceSession = new WorkspaceSession(handlers, undefined, service);
    plan.opens.push(file);
    await reopened.dispatch({ type: 'open' });
    assert.deepEqual(reopened.bankImports(), expected);
    await reopened.dispatch({ type: 'import-statement' });
    assert.equal(reopened.state().importOutcome?.status, 'skipped');
    assert.equal(reopened.state().workspace?.dirty, false);
    assert.equal(calls, 1);
    await fsPromises.appendFile(source, 'A distinct synthetic source revision');
    await reopened.dispatch({ type: 'import-statement' });
    assert.equal(reopened.bankImports().length, 2);
    assert.equal(reopened.bankImports().flatMap((value: StoredBankImport): { rowId: string; transactionId: string; }[] => value.transactions).length, 4);
    assert.equal(reopened.state().workspace?.dirty, true);
    assert.equal(calls, 2);
});

test('failed/cancelled saves and failed Open retain unsaved imports; explicit discard clears only current in-memory work', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    const { plan, handlers }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
    const service: StatementImportService = new StatementImportService({ choose: async (): Promise<string> => Promise.resolve(source), extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => Promise.resolve(extracted(bytes, id)) });
    const session: WorkspaceSession = new WorkspaceSession(handlers, undefined, service);
    await session.dispatch({ type: 'new' });
    await session.dispatch({ type: 'import-statement' });
    const expected: StoredBankImport[] = session.bankImports();
    const id: string = session.state().workspace!.id;
    plan.choices.push('save');
    plan.saves.push(null);
    await session.dispatch({ type: 'new' });
    assert.equal(session.state().workspace!.id, id);
    assert.deepEqual(session.bankImports(), expected);
    const collision: string = path.join(directory, 'unrelated.receiptmatch');
    await writeFile(collision, 'Unrelated original');
    plan.saves.push(collision);
    await session.dispatch({ type: 'save' });
    assert.ok(session.state().error);
    assert.equal(session.state().workspace?.dirty, true);
    assert.deepEqual(session.bankImports(), expected);
    assert.equal(await readFile(collision, 'utf8'), 'Unrelated original');
    plan.choices.push('discard');
    plan.opens.push(path.join(directory, 'missing.receiptmatch'));
    await session.dispatch({ type: 'open' });
    assert.deepEqual(session.bankImports(), expected);
    const file: string = path.join(directory, 'saved.receiptmatch');
    plan.saves.push(file);
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().workspace?.dirty, false);
    await session.dispatch({ type: 'rename', name: 'Will discard' });
    plan.choices.push('cancel');
    assert.equal(await session.requestClose(), false);
    assert.deepEqual(session.bankImports(), expected);
    plan.choices.push('discard');
    await session.dispatch({ type: 'new' });
    assert.deepEqual(session.bankImports(), []);
    assert.deepEqual((await loadWorkspace(file)).imports, expected);
});

test('cancellation wins over a late successful import and all competing workspace actions remain blocked', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    const { plan, handlers }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
    const preparer: StatementImportService = new StatementImportService({ choose: async (): Promise<string> => Promise.resolve(source), extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => Promise.resolve(extracted(bytes, id)) });
    const prepared: BankImportRunResult = await preparer.run({ existing: [] });
    assert.equal(prepared.status, 'imported');
    let release: ((result: BankImportRunResult) => void) | undefined;
    let progress: ((value: ExtractionProgress) => void) | undefined;
    const service: BankImportService = {
        run: (options: BankImportOptions): Promise<BankImportRunResult> => {
            progress = options.onProgress;
            return new Promise((resolve: (value: BankImportRunResult | PromiseLike<BankImportRunResult>) => void): void => {
                release = resolve;
            });
        }
    };
    let changes: number = 0;
    const session: WorkspaceSession = new WorkspaceSession(
        handlers,
        (): void => {
            changes++;
        },
        service
    );
    await session.dispatch({ type: 'new' });
    plan.saves.push(path.join(directory, 'empty.receiptmatch'));
    await session.dispatch({ type: 'save' });
    const id: string = session.state().workspace!.id;
    const pending: Promise<WorkspaceState> = session.dispatch({ type: 'import-statement' });
    await waitFor((): boolean => !!release);
    const tick: ExtractionProgress = { phase: 'text', pageNumber: 1, pageCount: 1, completedPages: 0 };
    progress!(tick);
    assert.equal(session.state().statementImport?.progress?.phase, 'text');
    assert.equal(session.state().workspace?.dirty, false);
    for (const command of [{ type: 'new' }, { type: 'open' }, { type: 'save' }, { type: 'rename', name: 'Blocked' }, { type: 'import-statement' }] as const) {
        assert.ok((await session.dispatch(command)).error);
        assert.equal(session.state().workspace!.id, id);
    }
    assert.equal(await session.requestClose(), false);
    await session.dispatch({ type: 'cancel-import' });
    assert.equal(session.state().statementImport?.cancelling, true);
    const changesAtCancel: number = changes;
    progress!({ ...tick, phase: 'ocr' });
    assert.equal(changes, changesAtCancel);
    release!(prepared);
    await pending;
    assert.equal(session.state().importOutcome?.status, 'cancelled');
    assert.equal(session.state().busy, false);
    assert.equal(session.state().workspace?.dirty, false);
    assert.deepEqual(session.bankImports(), []);
    const after: number = changes;
    progress!(tick);
    assert.equal(changes, after);
    assert.equal(session.state().statementImport, null);
});

test('service cancellation and failure outcomes do not create records or dirty a saved session; late engine progress is ignored', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    let chosen: number = 0;
    let onProgress: ((progress: ExtractionProgress) => void) | undefined;
    let progressCalls: number = 0;
    const service: StatementImportService = new StatementImportService({
        choose: async (): Promise<string> => {
            chosen++;
            return Promise.resolve(source);
        },
        extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void; }): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => {
            onProgress = options.onProgress;
            return Promise.resolve(extracted(bytes, id));
        }
    });
    const aborted: AbortController = new AbortController();
    aborted.abort();
    assert.equal((await service.run({ existing: [], signal: aborted.signal })).status, 'cancelled');
    assert.equal(chosen, 0);
    await service.run({
        existing: [],
        onProgress: (): void => {
            progressCalls++;
        }
    });
    onProgress!({ phase: 'ocr', pageNumber: 1, pageCount: 1, completedPages: 0 });
    assert.equal(progressCalls, 0);
    for (const result of [
        { status: 'cancelled' },
        { status: 'failed', issues: [importIssue('synthetic-failure', 'Synthetic failure.')] },
        { status: 'unsupported', issues: [importIssue('synthetic-unsupported', 'Synthetic unsupported statement.')] }
    ] as const) {
        const { plan, handlers }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
        const fixed: BankImportService = { run: async (): Promise<BankImportRunResult> => Promise.resolve(structuredClone(result) as BankImportRunResult) };
        const session: WorkspaceSession = new WorkspaceSession(handlers, undefined, fixed);
        await session.dispatch({ type: 'new' });
        plan.saves.push(path.join(directory, `${result.status}.receiptmatch`));
        await session.dispatch({ type: 'save' });
        await session.dispatch({ type: 'import-statement' });
        assert.equal(session.state().importOutcome?.status, result.status);
        assert.equal(session.state().workspace?.dirty, false);
        assert.deepEqual(session.bankImports(), []);
    }
    const noWorkspace: WorkspaceSession = new WorkspaceSession(dialogs().handlers, undefined, service);
    assert.ok((await noWorkspace.dispatch({ type: 'import-statement' })).error);
});

test('service checks cancellation again after native selection and extraction, ignoring late engine progress/results', async (): Promise<void> => {
    const { source }: { directory: string; source: string; } = await fixtures();
    let choose: ((value: string) => void) | undefined;
    let extractedCalls: number = 0;
    const chooser: StatementImportService = new StatementImportService({
        choose: (): Promise<string | null> =>
            new Promise((resolve: (value: string | PromiseLike<string | null> | null) => void): void => {
                choose = resolve;
            }),
        extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => {
            extractedCalls++;
            return Promise.resolve(extracted(bytes, id));
        }
    });
    const first: AbortController = new AbortController();
    const choosing: Promise<BankImportRunResult> = chooser.run({ existing: [], signal: first.signal });
    await waitFor((): boolean => !!choose);
    first.abort();
    choose!(source);
    assert.equal((await choosing).status, 'cancelled');
    assert.equal(extractedCalls, 0);
    let finish: (() => void) | undefined;
    let lateProgress: ((value: ExtractionProgress) => void) | undefined;
    let forwarded: number = 0;
    const engine: StatementImportService = new StatementImportService({
        choose: async (): Promise<string> => Promise.resolve(source),
        extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void; }): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => {
            lateProgress = options.onProgress;
            await new Promise<void>((resolve: (value: void | PromiseLike<void>) => void): void => {
                finish = resolve;
            });
            return extracted(bytes, id);
        }
    });
    const second: AbortController = new AbortController();
    const processing: Promise<BankImportRunResult> = engine.run({
        existing: [],
        signal: second.signal,
        onProgress: (): void => {
            forwarded++;
        }
    });
    await waitFor((): boolean => !!finish);
    second.abort();
    lateProgress!({ phase: 'ocr', pageNumber: 1, pageCount: 1, completedPages: 0 });
    finish!();
    assert.equal((await processing).status, 'cancelled');
    assert.equal(forwarded, 0);
});

test('invalid saved import mappings report workspace data errors and preserve current unsaved work rather than suggesting a name change', async (): Promise<void> => {
    const { directory, source }: { directory: string; source: string; } = await fixtures();
    const service: StatementImportService = new StatementImportService({ choose: async (): Promise<string> => Promise.resolve(source), extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string): Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> => Promise.resolve(extracted(bytes, id)) });
    const prepared: BankImportRunResult = await service.run({ existing: [] });
    assert.equal(prepared.status, 'imported');
    if (prepared.status !== 'imported') {
        return;
    }
    const damagedFile: string = path.join(directory, 'invalid-manifest.receiptmatch');
    await createWorkspace(damagedFile, newMetadata(), [prepared.record]);
    const invalid: StoredBankImport = structuredClone(prepared.record);
    invalid.accounts[0].statementId = 'not-a-uuid';
    const db: Database.Database = new Database(damagedFile);
    try {
        db.prepare('UPDATE bank_imports SET record_json=? WHERE id=?').run(JSON.stringify(invalid), prepared.record.id);
    } finally {
        db.close();
    }
    const damagedHash: string = await fingerprint(damagedFile);
    const { plan, handlers }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
    const session: WorkspaceSession = new WorkspaceSession(handlers, undefined, service);
    await session.dispatch({ type: 'new' });
    await session.dispatch({ type: 'rename', name: 'Current unsaved work' });
    await session.dispatch({ type: 'import-statement' });
    const before: WorkspaceView | null = session.state().workspace;
    const records: StoredBankImport[] = session.bankImports();
    plan.choices.push('discard');
    plan.opens.push(damagedFile);
    await session.dispatch({ type: 'open' });
    assert.deepEqual(session.state().workspace, before);
    assert.deepEqual(session.bankImports(), records);
    assert.equal(session.state().workspace?.dirty, true);
    assert.equal(session.state().error, 'This workspace contains invalid or unsupported data and could not be opened or saved.');
    assert.doesNotMatch(session.state().error!, /workspace name|statementId|not-a-uuid/);
    assert.equal(await fingerprint(damagedFile), damagedHash);
    await session.dispatch({ type: 'rename', name: 'x'.repeat(121) });
    plan.saves.push(path.join(directory, 'name-rejected.receiptmatch'));
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, 'Enter a workspace name between 1 and 120 characters.');
    assert.deepEqual(session.bankImports(), records);
    assert.equal(session.state().workspace?.dirty, true);
});
