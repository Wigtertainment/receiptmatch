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

export const BUILTIN_BANK_ADAPTERS: readonly BankAdapter[] = [revolutAdapter, airwallexAdapter];

export function parseBankStatement(payload: unknown, adapters: readonly BankAdapter[] = BUILTIN_BANK_ADAPTERS): BankImportResult {
    const validated = bankImportInputSchema.safeParse(payload);
    if (!validated.success) return emptyImportResult(null, 'failed', importIssue('invalid-input', 'The extracted statement data does not satisfy the import contract.'));
    const input = validated.data;
    try {
        const ids = new Set<string>();
        for (const adapter of adapters) {
            const metadata = adapterMetadataSchema.parse(adapter.metadata);
            if (ids.has(metadata.adapterId)) throw new Error('Duplicate adapter registration.');
            ids.add(metadata.adapterId);
        }
        const identified = adapters.filter((adapter) => adapter.identify(input));
        if (!identified.length)
            return emptyImportResult(
                input,
                input.pages.every((page) => page.status === 'failed') ? 'failed' : 'unsupported',
                importIssue('unsupported-bank', 'No built-in adapter identified this statement.')
            );
        if (identified.length > 1)
            return emptyImportResult(input, 'unsupported', importIssue('ambiguous-adapter', 'Multiple adapters identified this statement; no adapter was selected.'));
        const adapter = identified[0];
        const parsed = bankImportResultSchema.safeParse(adapter.parse(input));
        if (!parsed.success) return emptyImportResult(input, 'failed', importIssue('invalid-adapter-result', 'The selected adapter returned an invalid result.'));
        const result = parsed.data;
        if (JSON.stringify(result.sourceProvenance) !== JSON.stringify(sourceProvenance(input))) {
            return emptyImportResult(input, 'failed', importIssue('invalid-adapter-provenance', 'The adapter result does not match the authorized extraction.'));
        }
        if (
            result.adapter &&
            (result.adapter.adapterId !== adapter.metadata.adapterId ||
                result.adapter.bankId !== adapter.metadata.bankId ||
                result.adapter.version !== adapter.metadata.version ||
                !adapter.metadata.layouts.some((layout) => layout.layoutId === result.adapter?.layoutId && layout.version === result.adapter.layoutVersion))
        ) {
            return emptyImportResult(input, 'failed', importIssue('invalid-adapter-version', 'The adapter result claims an unregistered adapter or layout version.'));
        }
        return result;
    } catch {
        return emptyImportResult(input, 'failed', importIssue('adapter-failed', 'The registered adapter could not interpret this extraction.'));
    }
}
