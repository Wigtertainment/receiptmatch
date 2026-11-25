import type { TransactionCandidate, UnresolvedDraft } from '../../shared/bank-import.js';

export type ImportRow = TransactionCandidate | UnresolvedDraft;

export function directionLabel(value: ImportRow['direction']): "Unknown" | "Incoming" | "Outgoing" {
    return value === 'incoming' ? 'Incoming' : value === 'outgoing' ? 'Outgoing' : 'Unknown';
}
