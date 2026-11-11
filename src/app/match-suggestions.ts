import { Component, computed, effect, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { formatCalendarDate, formatDocumentTotal, formatMoney } from '../shared/display.js';
import { applyDocumentCorrections, documentCorrectionKey } from '../shared/document-corrections.js';
import type { MatchApprovalSelection } from '../shared/match-approvals.js';
import type { WorkspaceView } from '../shared/protocol.js';
import type { MatchCandidateView, MatchDetails, MatchReview, MatchSummary } from '../shared/workspace-matching.js';
import type { StoredSupportingDocument } from '../shared/workspace-documents.js';
import { DocumentAnalysis } from './document-imports.js';

type MatchStatus = MatchSummary['status'];
type Filter = 'all' | MatchStatus;
interface ReviewDocument { id: string; name: string; path: string; total: string | null; record: StoredSupportingDocument; }

@Component({
	selector: 'app-match-suggestions', standalone: true, imports: [NgTemplateOutlet, DocumentAnalysis], templateUrl: './match-suggestions.html',
})
export class MatchSuggestions {
	readonly workspace = input.required<WorkspaceView>();
	readonly active = input.required<boolean>();
	readonly busy = input.required<boolean>();
	readonly filters = ['all', 'reliable', 'uncertain', 'unmatched'] as const;
	readonly statusLabels: Record<MatchStatus, string> = { reliable: 'Reliable', uncertain: 'Uncertain', unmatched: 'Unmatched' };
	readonly reviewLabels: Record<MatchReview['status'], string> = { open: 'Open', assigned: 'Document assigned', 'completed-without-document': 'Completed without document' };
	readonly approvalLabels = { approved: 'Approved', stale: 'Approval needs review', revoked: 'Approval revoked' } as const;
	readonly approvalChanges = {
		booking: 'The booking was corrected.', document: 'The supporting document was corrected.', 'booking-and-document': 'The booking and supporting document were corrected.',
	} as const;
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
	private readonly summaryRequest = signal<{ revision: number; loadRevision: number; rows: MatchSummary[] | null } | null>(null);
	private readonly detailRequest = signal<{ revision: number; transactionId: string; value: MatchDetails | null } | null>(null);
	private readonly documentRequest = signal<{ key: string; documents: ReviewDocument[] | null } | null>(null);
	private readonly documentRetry = signal(0);
	private readonly documentKey = computed(() => {
		const workspace = this.workspace();
		return JSON.stringify([workspace.loadRevision, workspace.documentImports.map(report => report.id), workspace.documentCorrections.map(correction => correction.revision)]);
	});
	private readonly documentDraft = signal<{ loadRevision: number; transactionId: string; id: string } | null>(null);
	private readonly pending = signal(false);
	private readonly batchSelection = signal<{ loadRevision: number; rows: ReadonlyMap<string, MatchApprovalSelection> } | null>(null);
	private readonly batchFeedback = signal<{ loadRevision: number; message: string; error: boolean; transactionId?: string } | null>(null);
	private readonly reviewFeedback = signal<{ loadRevision: number; transactionId: string; message: string } | null>(null);
	private readonly summaryRetry = signal(0);
	private readonly detailRetry = signal(0);
	private readonly revision = computed(() => this.workspace().matchRevision);
	private readonly currentSummary = computed(() => {
		const result = this.summaryRequest();
		return result?.revision === this.revision() ? result : null;
	});
	readonly filter = computed(() => this.filterState()?.loadRevision === this.workspace().loadRevision ? this.filterState()!.filter : 'all');
	readonly rows = computed(() => {
		const result = this.summaryRequest();
		return result?.loadRevision === this.workspace().loadRevision ? result.rows : null;
	});
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
	readonly selectedRow = computed<MatchSummary | null>(() => {
		const rows = this.filteredRows();
		const selected = this.selected();
		const id = selected?.loadRevision === this.workspace().loadRevision ? selected.transactionId : null;
		return rows.find(row => row.transactionId === id) ?? rows[0] ?? null;
	});
	readonly reviewDisabled = computed(() => this.busy() || this.pending() || !this.currentSummary()?.rows);
	readonly approvalSelections = computed(() => {
		const selection = this.batchSelection();
		return selection?.loadRevision === this.workspace().loadRevision ? selection.rows : null;
	});
	readonly hiddenApprovalCount = computed(() => {
		const selected = this.approvalSelections();
		return selected ? selected.size - this.filteredRows().filter(row => selected.has(row.transactionId)).length : 0;
	});
	readonly approvalFeedback = computed(() => {
		const feedback = this.batchFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision ? feedback : null;
	});
	readonly reviewError = computed(() => {
		const feedback = this.reviewFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision && feedback.transactionId === this.selectedRow()?.transactionId ? feedback.message : null;
	});
	readonly documents = computed(() => this.documentRequest()?.key === this.documentKey() ? this.documentRequest()!.documents : null);
	readonly documentsFailed = computed(() => this.documentRequest()?.key === this.documentKey() && this.documentRequest()?.documents === null);
	readonly duplicateDocumentNames = computed(() => {
		const seen = new Set<string>();
		const duplicates = new Set<string>();
		for (const { name } of this.documents() ?? []) {
			if (seen.has(name)) duplicates.add(name);
			seen.add(name);
		}
		return duplicates;
	});
	readonly owners = computed(() => new Map((this.rows() ?? []).flatMap(row => row.review.status === 'assigned' ? [[row.review.documentId, row] as const] : [])));
	readonly assignedDocument = computed(() => {
		const review = this.selectedRow()?.review;
		return review?.status === 'assigned' ? this.documents()?.find(item => item.id === review.documentId) : null;
	});
	readonly selectedDocumentId = computed(() => {
		const draft = this.documentDraft();
		if (draft?.loadRevision === this.workspace().loadRevision && draft.transactionId === this.selectedRow()?.transactionId) return draft.id;
		return this.assignedDocument()?.id ?? '';
	});
	readonly selectedDocument = computed(() => this.documents()?.find(item => item.id === this.selectedDocumentId()));
	readonly previewDocumentId = signal<string | null>(null);
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
			const loadRevision = untracked(() => this.workspace().loadRevision);
			let current = true;
			onCleanup(() => { current = false; });
			const update = (rows: MatchSummary[] | null) => {
				if (current && this.active() && this.revision() === matchRevision) this.summaryRequest.set({ revision: matchRevision, loadRevision, rows });
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
		effect(onCleanup => {
			const key = this.documentKey();
			this.documentRetry();
			if (!this.active() || untracked(() => this.documentRequest()?.key === key)) return;
			const { documentImports, documentCorrections } = untracked(this.workspace);
			const reportIds = documentImports.map(report => report.id);
			if (!reportIds.length) { this.documentRequest.set({ key, documents: [] }); return; }
			let current = true;
			onCleanup(() => { current = false; });
			const update = (documents: ReviewDocument[] | null) => {
				if (current && this.active() && this.documentKey() === key) this.documentRequest.set({ key, documents });
			};
			void window.receiptmatch.documentImports().then(records => {
				if (records.length !== reportIds.length || records.some((record, index) => record.id !== reportIds[index])) return update(null);
				const corrections = new Map(documentCorrections.map(correction => [documentCorrectionKey(correction, correction.change.kind), correction]));
				const documents = applyDocumentCorrections(records, corrections).flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [{
					id: file.record.id, name: this.basename(file.record.filePath), path: file.record.filePath, total: formatDocumentTotal(file.record.result), record: file.record,
				}] : []));
				update(documents.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)));
			}).catch(() => update(null));
		});
	}

	setFilter(filter: Filter) {
		const previous = this.selectedRow()?.transactionId;
		this.filterState.set({ filter, loadRevision: this.workspace().loadRevision });
		if (previous !== this.selectedRow()?.transactionId) this.resetDetail();
	}
	selectTransaction(transactionId: string, event: MouseEvent) {
		const { loadRevision } = this.workspace();
		if (transactionId !== this.selectedRow()?.transactionId) this.resetDetail();
		this.selected.set({ transactionId, loadRevision });
		const stacked = window.matchMedia('(width < 1000px)').matches;
		if (event.detail === 0 || stacked) requestAnimationFrame(() => {
			if (this.active() && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId) {
				document.getElementById('match-detail-heading')?.focus({ preventScroll: !stacked });
			}
		});
	}
	private resetDetail() {
		this.previewDocumentId.set(null);
		const panel = document.getElementById('match-detail-panel');
		if (panel) panel.scrollTop = 0;
	}
	focusSelectedTransaction(transactionId: string) { document.getElementById('match-transaction-' + transactionId)?.focus(); }
	documentLabel(item: ReviewDocument, owner?: MatchSummary) {
		const parts = [this.duplicateDocumentNames().has(item.name) ? item.path : item.name];
		if (item.total) parts.push(item.total);
		if (owner) parts.push('Assigned to ' + this.transactionName(owner.description));
		return parts.join(' · ');
	}
	chooseDocument(event: Event) {
		const row = this.selectedRow();
		this.previewDocumentId.set(null);
		if (row) this.documentDraft.set({ loadRevision: this.workspace().loadRevision, transactionId: row.transactionId, id: (event.target as HTMLSelectElement).value });
	}
	toggleDocumentPreview(documentId: string, event: Event) {
		if (this.selectedDocumentId() === documentId) this.previewDocumentId.set((event.target as HTMLDetailsElement).open ? documentId : null);
	}
	selectForApproval(row: MatchSummary, event: Event) {
		if (this.reviewDisabled()) return;
		const rows = new Map(this.approvalSelections());
		if (!(event.target as HTMLInputElement).checked) rows.delete(row.transactionId);
		else if (row.approvalSelection && !row.approval) rows.set(row.transactionId, row.approvalSelection);
		this.batchSelection.set({ loadRevision: this.workspace().loadRevision, rows });
		this.batchFeedback.set(null);
	}
	clearApprovalSelection() {
		this.batchSelection.set(null);
		this.batchFeedback.set(null);
		document.getElementById('match-list-heading')?.focus({ preventScroll: true });
	}
	async approveSelected() {
		const selected = this.approvalSelections();
		if (!selected?.size || this.reviewDisabled()) return;
		const { loadRevision } = this.workspace();
		const trigger = document.activeElement;
		let focusId = 'match-batch-result';
		this.pending.set(true);
		this.batchFeedback.set(null);
		try {
			const result = await window.receiptmatch.command({ type: 'approve-matches', loadRevision, selections: [...selected.values()] });
			if (this.workspace().loadRevision !== loadRevision) return;
			if (result.error) {
				const transactionId = result.approvalIssue?.transactionId;
				if (transactionId) {
					const remaining = new Map(selected);
					remaining.delete(transactionId);
					this.batchSelection.set({ loadRevision, rows: remaining });
					if (this.rows()?.some(row => row.transactionId === transactionId)) {
						if (!this.filteredRows().some(row => row.transactionId === transactionId)) this.setFilter('all');
						if (this.selectedRow()?.transactionId !== transactionId) this.resetDetail();
						this.selected.set({ transactionId, loadRevision });
						focusId = 'match-transaction-' + transactionId;
					}
				}
				if (transactionId || result.busy) this.batchFeedback.set({ loadRevision, message: result.error, error: true, transactionId });
			} else {
				this.batchSelection.set(null);
				this.batchFeedback.set({ loadRevision, message: 'Selected transactions approved.', error: false });
			}
		} catch {
			this.batchFeedback.set({ loadRevision, message: 'The selected transactions could not be approved. Try again.', error: true });
		} finally {
			this.pending.set(false);
			requestAnimationFrame(() => {
				if (!this.active() || this.workspace().loadRevision !== loadRevision || (document.activeElement !== trigger && document.activeElement !== document.body)) return;
				const target = document.getElementById(focusId);
				target?.focus({ preventScroll: true });
				if (focusId !== 'match-batch-result') target?.scrollIntoView({ block: 'center', inline: 'nearest' });
			});
		}
	}
	async applyReview(review: MatchReview) {
		const row = this.selectedRow();
		if (this.reviewDisabled() || !row) return;
		const { transactionId } = row;
		const { loadRevision, matchRevision } = this.workspace();
		const trigger = document.activeElement;
		this.pending.set(true);
		this.reviewFeedback.set(null);
		try {
			const result = await window.receiptmatch.command({ type: 'review-match', transactionId, revision: matchRevision, review });
			// The session publishes validation errors. It returns busy rejections only to this caller.
			if (result.busy && result.error) this.reviewFeedback.set({ loadRevision, transactionId, message: result.error });
			if (!result.error && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId) this.documentDraft.set(null);
		} catch {
			this.reviewFeedback.set({ loadRevision, transactionId, message: 'The review decision could not be recorded. Please try again.' });
		} finally {
			this.pending.set(false);
			requestAnimationFrame(() => {
				if (this.active() && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId &&
					(document.activeElement === trigger || document.activeElement === document.body)) {
					document.getElementById('match-review-heading')?.focus();
				}
			});
		}
	}
	retryDocuments() { this.documentRequest.set(null); this.documentRetry.update(value => value + 1); }
	retrySummaries() { this.summaryRequest.set(null); this.summaryRetry.update(value => value + 1); }
	retryDetails() { this.detailRequest.set(null); this.detailRetry.update(value => value + 1); }
}
