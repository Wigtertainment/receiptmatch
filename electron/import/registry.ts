import type { BankImportInput, ImportPage } from "../../src/shared/bank-import.js";
import {
    adapterMetadataSchema,
    bankImportInputSchema,
    bankImportResultSchema,
    emptyImportResult,
    importIssue,
    sourceProvenance,
    type BankAdapter,
    type BankImportResult
} from '../../src/shared/bank-import.js';
import { revolutAdapter } from './revolut.js';
import { airwallexAdapter } from './airwallex.js';
import type { ZodSafeParseResult } from 'zod';

export const BUILTIN_BANK_ADAPTERS: readonly BankAdapter[] = [revolutAdapter, airwallexAdapter];

export function parseBankStatement(payload: unknown, adapters: readonly BankAdapter[] = BUILTIN_BANK_ADAPTERS): BankImportResult {
    const validated: ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(payload);
    if (!validated.success) {
        return emptyImportResult(null, 'failed', importIssue('invalid-input', 'The extracted statement data does not satisfy the import contract.'));
    }
    const input: BankImportInput = validated.data;
    try {
        const ids: Set<string> = new Set<string>();
        for (const adapter of adapters) {
            const metadata: { bankId: string; adapterId: string; version: string; layouts: { layoutId: string; version: string; }[]; } = adapterMetadataSchema.parse(adapter.metadata);
            if (ids.has(metadata.adapterId)) {
                throw new Error('Duplicate adapter registration.');
            }
            ids.add(metadata.adapterId);
        }
        const identified: BankAdapter[] = adapters.filter((adapter: BankAdapter): boolean => adapter.identify(input));
        if (!identified.length) {
                return emptyImportResult(
                input,
                input.pages.every((page: ImportPage): boolean => page.status === 'failed') ? 'failed' : 'unsupported',
                importIssue('unsupported-bank', 'No built-in adapter identified this statement.')
            );
            }
        if (identified.length > 1) {
                return emptyImportResult(input, 'unsupported', importIssue('ambiguous-adapter', 'Multiple adapters identified this statement; no adapter was selected.'));
            }
        const adapter: BankAdapter = identified[0];
        const parsed: ZodSafeParseResult<BankImportResult> = bankImportResultSchema.safeParse(adapter.parse(input));
        if (!parsed.success) {
            return emptyImportResult(input, 'failed', importIssue('invalid-adapter-result', 'The selected adapter returned an invalid result.'));
        }
        const result: BankImportResult = parsed.data;
        if (JSON.stringify(result.sourceProvenance) !== JSON.stringify(sourceProvenance(input))) {
            return emptyImportResult(input, 'failed', importIssue('invalid-adapter-provenance', 'The adapter result does not match the authorized extraction.'));
        }
        if (
            result.adapter &&
            (result.adapter.adapterId !== adapter.metadata.adapterId ||
                result.adapter.bankId !== adapter.metadata.bankId ||
                result.adapter.version !== adapter.metadata.version ||
                !adapter.metadata.layouts.some((layout: { layoutId: string; version: string; }): boolean => layout.layoutId === result.adapter?.layoutId && layout.version === result.adapter.layoutVersion))
        ) {
            return emptyImportResult(input, 'failed', importIssue('invalid-adapter-version', 'The adapter result claims an unregistered adapter or layout version.'));
        }
        return result;
    } catch {
        return emptyImportResult(input, 'failed', importIssue('adapter-failed', 'The registered adapter could not interpret this extraction.'));
    }
}
