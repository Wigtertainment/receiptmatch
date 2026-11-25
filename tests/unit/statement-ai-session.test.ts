import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { BankImportInput } from '../../src/shared/bank-import.js';
import { importIssue } from '../../src/shared/bank-import.js';
import type { StatementFallbackState, IWorkspaceState } from '../../src/shared/protocol.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import type { BankImportAttempt, IBankImportOptions, IBankImportService, IStatementFallback, StatementFallbackResult } from '../../electron/import/service.js';
import { parseBankStatement } from '../../electron/import/registry.js';
import { WorkspaceSession, type IWorkspaceDialogs } from '../../electron/workspace-session.js';
import { row, statement } from './bank-fixtures.js';

interface IStatementSessionFixture { session: WorkspaceSession; dialogs: IWorkspaceDialogs; record: StoredBankImport; savedFile: string }

const pdf: string = 'Synthetic statement snapshot for session tests';

function proposal(filePath: string): StoredBankImport {
    const input: BankImportInput = statement();
    input.source = { sourceId: randomUUID(), sha256: createHash('sha256').update(pdf).digest('hex') };
    input.pages[0].spans.push(...row(350, '31 Feb 2032', 'Synthetic unresolved row', '2.00', null));
    const result: StoredBankImport['result'] = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    result.adapter = null;
    result.localRecognition = { model: 'nuextract3', parserVersion: '1' };
    result.accountSections[0].accountReference = null;
    return { id: randomUUID(), filePath, importedAt: new Date().toISOString(), result,
        accounts: result.accountSections.map((section: StoredBankImport['result']['accountSections'][number]): StoredBankImport['accounts'][number] => ({ sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
        transactions: result.transactions.map((item: StoredBankImport['result']['transactions'][number]): StoredBankImport['transactions'][number] => ({ rowId: item.rowId, transactionId: randomUUID() })),
        drafts: result.unresolvedDrafts.map((item: StoredBankImport['result']['unresolvedDrafts'][number]): StoredBankImport['drafts'][number] => ({ rowId: item.rowId, draftId: randomUUID() })) };
}

function fixture(root: string, recognize?: IStatementFallback['run'], cancelSelection?: () => boolean): IStatementSessionFixture {
    const record: StoredBankImport = proposal(path.join(root, 'unknown.pdf'));
    const savedFile: string = path.join(root, 'workspace.receiptmatch');
    const dialogs: IWorkspaceDialogs = {
        save: (): Promise<string> => Promise.resolve(savedFile), open: (): Promise<string> => Promise.resolve(savedFile), unsaved: (): Promise<'discard'> => Promise.resolve('discard')
    };
    const statementImportService: IBankImportService = { run(options: IBankImportOptions): Promise<BankImportAttempt> {
        if (cancelSelection?.()) {
            return Promise.resolve({ status: 'cancelled' });
        }
        if (options.existing.some((existing: StoredBankImport): boolean => existing.id === record.id)) {
            return Promise.resolve({ status: 'skipped', importId: record.id });
        }
        return Promise.resolve({ status: 'unsupported', issues: [importIssue('unsupported-bank', 'No configured adapter.')], fallback: {
            filePath: record.filePath, run: recognize ?? ((): Promise<StatementFallbackResult> => Promise.resolve({ status: 'proposed', record }))
        } });
    } };
    return { session: new WorkspaceSession(dialogs, undefined, statementImportService), dialogs, record, savedFile };
}

function pending(state: IWorkspaceState, stage: StatementFallbackState['stage']): StatementFallbackState {
    assert.ok(state.statementFallback);
    assert.equal(state.statementFallback.stage, stage);
    return state.statementFallback;
}

test('a local AI preview changes neither workspace nor matching until the review token is confirmed', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-statement-ai-'));
    try {
        let cancelSelection: boolean = false;
        const { session, dialogs, record, savedFile }: ReturnType<typeof fixture> = fixture(root, undefined, (): boolean => cancelSelection);
        await writeFile(record.filePath, pdf);
        await session.dispatch({ type: 'new' });
        await session.dispatch({ type: 'save' });
        const before: number = session.state().workspace!.matchRevision;
        const offer: StatementFallbackState = pending(await session.dispatch({ type: 'import-statement' }), 'offer');
        assert.equal(offer.fileName, 'unknown.pdf');
        assert.equal((await session.dispatch({ type: 'confirm-statement-ai', token: offer.token })).workspace?.imports.length, 0);
        const review: StatementFallbackState = pending(await session.dispatch({ type: 'try-statement-ai', token: offer.token }), 'review');
        assert.notEqual(review.token, offer.token);
        cancelSelection = true;
        assert.equal((await session.dispatch({ type: 'import-statement' })).statementFallback?.token, review.token);
        cancelSelection = false;
        assert.equal(session.state().workspace?.dirty, false);
        assert.deepEqual(session.bankImports(), []);
        assert.deepEqual(session.matchSummaries(before), []);
        assert.equal((await session.dispatch({ type: 'save' })).workspace?.filePath, savedFile);
        const proposalOnly: WorkspaceSession = new WorkspaceSession(dialogs);
        await proposalOnly.dispatch({ type: 'open' });
        assert.deepEqual(proposalOnly.bankImports(), []);
        assert.equal(proposalOnly.state().statementFallback, undefined);
        assert.equal((await session.dispatch({ type: 'confirm-statement-ai', token: offer.token })).workspace?.imports.length, 0);

        assert.equal(review.stage, 'review');
        review.result.transactions.length = 0;
        const imported: IWorkspaceState = await session.dispatch({ type: 'confirm-statement-ai', token: review.token });
        assert.equal(imported.statementFallback, undefined);
        assert.equal(imported.importOutcome?.status, 'imported');
        assert.equal(imported.workspace?.imports[0].bankId, null);
        assert.equal(imported.workspace?.imports[0].drafts, 1);
        assert.equal(imported.workspace?.dirty, true);
        assert.equal(imported.workspace?.matchRevision, before + 1);
        assert.equal(session.matchSummaries(before + 1)?.length, record.transactions.length);
        assert.equal((await session.dispatch({ type: 'import-statement' })).importOutcome?.status, 'skipped');
        await session.dispatch({ type: 'save' });
        await proposalOnly.dispatch({ type: 'open' });
        assert.deepEqual(proposalOnly.bankImports(), [record]);
        assert.equal(proposalOnly.state().workspace?.dirty, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects a changed PDF at confirmation and invalidates offers when switching workspaces', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-statement-ai-'));
    try {
        const { session, record }: ReturnType<typeof fixture> = fixture(root);
        await writeFile(record.filePath, pdf);
        await session.dispatch({ type: 'new' });
        const offer: StatementFallbackState = pending(await session.dispatch({ type: 'import-statement' }), 'offer');
        const review: StatementFallbackState = pending(await session.dispatch({ type: 'try-statement-ai', token: offer.token }), 'review');
        await writeFile(record.filePath, 'Different PDF bytes');
        const failed: IWorkspaceState = await session.dispatch({ type: 'confirm-statement-ai', token: review.token });
        assert.equal(failed.importOutcome?.issues[0].code, 'source-changed');
        assert.equal(failed.statementFallback, undefined);
        assert.deepEqual(session.bankImports(), []);
        await writeFile(record.filePath, pdf);
        const next: StatementFallbackState = pending(await session.dispatch({ type: 'import-statement' }), 'offer');
        const discarded: StatementFallbackState = pending(await session.dispatch({ type: 'try-statement-ai', token: next.token }), 'review');
        assert.equal((await session.dispatch({ type: 'discard-statement-ai', token: discarded.token })).statementFallback, undefined);
        assert.equal((await session.dispatch({ type: 'confirm-statement-ai', token: discarded.token })).workspace?.imports.length, 0);
        const replaced: StatementFallbackState = pending(await session.dispatch({ type: 'import-statement' }), 'offer');
        assert.equal((await session.dispatch({ type: 'new' })).statementFallback, undefined);
        assert.equal((await session.dispatch({ type: 'try-statement-ai', token: replaced.token })).statementFallback, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('preserves the offer on unavailable recognition and cancellation until the user discards it', async (): Promise<void> => {
    let attempt: number = 0;
    const { session }: ReturnType<typeof fixture> = fixture(tmpdir(), ({ signal }: Parameters<IStatementFallback['run']>[0]): Promise<StatementFallbackResult> => {
        if (++attempt === 1) {
            return Promise.resolve({ status: 'unavailable', issues: [importIssue('model-unavailable', 'Install NuExtract3.')] });
        }
        return new Promise((resolve: (value: StatementFallbackResult) => void): void => {
            signal!.addEventListener('abort', (): void => resolve({ status: 'cancelled' }), { once: true });
        });
    });
    await session.dispatch({ type: 'new' });
    const offer: StatementFallbackState = pending(await session.dispatch({ type: 'import-statement' }), 'offer');
    const unavailable: IWorkspaceState = await session.dispatch({ type: 'try-statement-ai', token: offer.token });
    assert.equal(unavailable.importOutcome?.issues[0].code, 'model-unavailable');
    assert.equal(unavailable.statementFallback?.token, offer.token);
    const running: Promise<IWorkspaceState> = session.dispatch({ type: 'try-statement-ai', token: offer.token });
    assert.equal(session.state().statementImport?.localAi, true);
    await session.dispatch({ type: 'cancel-import' });
    assert.equal((await running).importOutcome?.status, 'cancelled');
    assert.equal(session.state().statementFallback?.token, offer.token);
    await session.dispatch({ type: 'discard-statement-ai', token: offer.token });
    assert.equal(session.state().statementFallback, undefined);
    assert.deepEqual(session.bankImports(), []);
});
