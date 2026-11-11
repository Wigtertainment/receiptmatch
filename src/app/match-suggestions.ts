import { Component, computed, effect, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { formatCalendarDate, formatMoney } from '../shared/display.js';
import type { WorkspaceView } from '../shared/protocol.js';
import type { MatchCandidateView, MatchDetails, MatchSummary } from '../shared/workspace-matching.js';

type MatchStatus = MatchSummary['status'];
type Filter = 'all' | MatchStatus;

@Component({
	selector: 'app-match-suggestions', standalone: true, imports: [NgTemplateOutlet], templateUrl: './match-suggestions.html',
})
export class MatchSuggestions {
	readonly workspace = input.required<WorkspaceView>();
	readonly active = input.required<boolean>();
	readonly filters = ['all', 'reliable', 'uncertain', 'unmatched'] as const;
	readonly statusLabels: Record<MatchStatus, string> = { reliable: 'Reliable', uncertain: 'Uncertain', unmatched: 'Unmatched' };
	readonly issueLabels: Record<MatchCandidateView['issues'][number], string> = {
		'missing-reference': 'No matching payment or document reference.',
		'conflicting-evidence': 'Some source details are ambiguous or conflict.',
		'competing-reference': 'Another possible match is supported by a reference.',
	};
	readonly sectionLabels: Record<MatchCandidateView['sectionKind'], string> = {
		invoice: 'Invoice', receipt: 'Receipt', 'credit-note': 'Credit note', 'billing-summary': 'Billing summary',
		'payment-information': 'Payment information', unknown: 'Document section',
	};
	readonly date = formatCalendarDate;
	readonly money = formatMoney;
	readonly round = Math.round;
	readonly basename = (filePath: string) => filePath.split(/[\\/]/).at(-1) || filePath;
	readonly transactionName = (description: string) => {
		const firstLine = description.trim().split(/\r?\n/, 1)[0];
		return firstLine.length > 140 ? firstLine.slice(0, 139) + '…' : firstLine || 'Transaction';
	};
	private readonly selected = signal<{ transactionId: string; loadRevision: number } | null>(null);
	private readonly filterState = signal<{ filter: Filter; loadRevision: number } | null>(null);
	private readonly summaryRequest = signal<{ revision: number; rows: MatchSummary[] | null } | null>(null);
	private readonly detailRequest = signal<{ revision: number; transactionId: string; value: MatchDetails | null } | null>(null);
	private readonly summaryRetry = signal(0);
	private readonly detailRetry = signal(0);
	private readonly revision = computed(() => this.workspace().matchRevision);
	private readonly currentSummary = computed(() => {
		const result = this.summaryRequest();
		return result?.revision === this.revision() ? result : null;
	});
	readonly filter = computed(() => this.filterState()?.loadRevision === this.workspace().loadRevision ? this.filterState()!.filter : 'all');
	readonly rows = computed(() => this.currentSummary()?.rows ?? null);
	readonly summariesFailed = computed(() => this.currentSummary()?.rows === null);
	readonly counts = computed(() => {
		const counts = { reliable: 0, uncertain: 0, unmatched: 0 };
		for (const row of this.rows() ?? []) counts[row.status]++;
		return counts;
	});
	readonly filteredRows = computed(() => {
		const rows = this.rows() ?? [];
		const filter = this.filter();
		return filter === 'all' ? rows : rows.filter(row => row.status === filter);
	});
	readonly selectedRow = computed(() => {
		const rows = this.filteredRows();
		const selected = this.selected();
		const id = selected?.loadRevision === this.workspace().loadRevision ? selected.transactionId : null;
		return rows.find(row => row.transactionId === id) ?? rows[0] ?? null;
	});
	private readonly candidateTransactionId = computed(() => {
		const row = this.selectedRow();
		return row?.candidateCount ? row.transactionId : null;
	});
	private readonly currentDetail = computed(() => {
		const result = this.detailRequest();
		return result?.revision === this.revision() && result.transactionId === this.candidateTransactionId() ? result : null;
	});
	readonly details = computed(() => this.currentDetail()?.value ?? null);
	readonly detailsFailed = computed(() => this.currentDetail()?.value === null);

	constructor() {
		effect(onCleanup => {
			const matchRevision = this.revision();
			this.summaryRetry();
			if (!this.active() || untracked(() => this.currentSummary())) return;
			let current = true;
			onCleanup(() => { current = false; });
			const update = (rows: MatchSummary[] | null) => {
				if (current && this.active() && this.revision() === matchRevision) this.summaryRequest.set({ revision: matchRevision, rows });
			};
			void window.receiptmatch.matchSummaries(matchRevision).then(update, () => update(null));
		});
		effect(onCleanup => {
			const transactionId = this.candidateTransactionId();
			const matchRevision = this.revision();
			this.detailRetry();
			if (!this.active() || !transactionId || untracked(() => this.currentDetail())) return;
			let current = true;
			onCleanup(() => { current = false; });
			const update = (value: MatchDetails | null) => {
				if (current && this.active() && this.revision() === matchRevision && this.candidateTransactionId() === transactionId) {
					this.detailRequest.set({ revision: matchRevision, transactionId, value });
				}
			};
			void window.receiptmatch.matchDetails(matchRevision, transactionId).then(update, () => update(null));
		});
	}

	setFilter(filter: Filter) {
		this.filterState.set({ filter, loadRevision: this.workspace().loadRevision });
	}
	selectTransaction(transactionId: string, event: MouseEvent) {
		const { loadRevision } = this.workspace();
		this.selected.set({ transactionId, loadRevision });
		if (event.detail === 0 || window.matchMedia('(width < 1000px)').matches) requestAnimationFrame(() => {
			if (this.active() && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId) {
				document.getElementById('match-detail-heading')?.focus();
			}
		});
	}
	focusSelectedTransaction(transactionId: string) { document.getElementById('match-transaction-' + transactionId)?.focus(); }
	retrySummaries() { this.summaryRequest.set(null); this.summaryRetry.update(value => value + 1); }
	retryDetails() { this.detailRequest.set(null); this.detailRetry.update(value => value + 1); }
}
