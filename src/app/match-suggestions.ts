import type { StoredDocumentImport } from "../shared/workspace-documents.js";
import type { ImportIssue } from "../shared/bank-import.js";
import type { SupportingDocument } from "../shared/supporting-document.js";
import { Component, computed, effect, input, signal, untracked, type EffectCleanupRegisterFn, type Signal, type WritableSignal, type InputSignal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { type TableConfig, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigCheckboxComponent, WigDropdownComponent, WigIconButtonComponent, WigTableComponent, WigTagComponent,
	WigTemplateDirective } from '@wigtertainment-ltd/comp-lib';
import { formatCalendarDate, formatMoney } from '../shared/display.js';
import { formatDocumentTotal } from '../shared/document-display.js';
import type { MatchApprovalSelection } from '../shared/match-approvals.js';
import type { WorkspaceState, DocumentSnapshot, DocumentImportSummary, WorkspaceView } from '../shared/protocol.js';
import type { MatchCandidateView, MatchDetails, MatchReview, MatchSummary } from '../shared/workspace-matching.js';
import type { StoredSupportingDocument } from '../shared/workspace-documents.js';
import { DocumentAnalysis } from './document-imports.js';
import { OriginalPreviewButton } from './original-preview-button.js';
import { ButtonPressed } from './button-pressed.js';
import type { Money } from '../shared/money.js';

type MatchStatus = MatchSummary['status'];
type Filter = 'all' | MatchStatus;
interface ReviewDocument { id: string; name: string; path: string; total: string | null; record: StoredSupportingDocument; }

@Component({
	selector: 'app-match-suggestions', standalone: true, templateUrl: './match-suggestions.html',
	imports: [NgTemplateOutlet, DocumentAnalysis, OriginalPreviewButton, ButtonPressed, WigAccordionComponent, WigAlertComponent, WigButtonComponent,
		WigCheckboxComponent, WigDropdownComponent, WigIconButtonComponent, WigTableComponent, WigTagComponent, WigTemplateDirective],
})
export class MatchSuggestions {
	readonly workspace: InputSignal<WorkspaceView> = input.required<WorkspaceView>();
	readonly active: InputSignal<boolean> = input.required<boolean>();
	readonly busy: InputSignal<boolean> = input.required<boolean>();
	readonly filters: readonly ["all", "reliable", "uncertain", "unmatched"] = ['all', 'reliable', 'uncertain', 'unmatched'] as const;
	readonly statusLabels: Record<MatchStatus, string> = { reliable: 'Reliable', uncertain: 'Uncertain', unmatched: 'Unmatched' };
	readonly reviewLabels: Record<MatchReview['status'], string> = { open: 'Open', assigned: 'Document assigned', 'completed-without-document': 'Completed without document' };
	readonly approvalLabels: { readonly approved: "Approved"; readonly stale: "Approval needs review"; readonly revoked: "Approval revoked"; } = { approved: 'Approved', stale: 'Approval needs review', revoked: 'Approval revoked' } as const;
	readonly approvalChanges: { readonly booking: "The booking was corrected."; readonly document: "The supporting document was corrected."; readonly 'booking-and-document': "The booking and supporting document were corrected."; } = {
		booking: 'The booking was corrected.', document: 'The supporting document was corrected.', 'booking-and-document': 'The booking and supporting document were corrected.',
	} as const;
	readonly issueLabels: Record<MatchCandidateView['issues'][number], string> = {
		'missing-reference': 'No matching payment or document reference.',
		'conflicting-evidence': 'Some source details are ambiguous or conflict.',
		'competing-reference': 'Another possible match is supported by a reference.',
		'amount-needs-review': 'The reference matches. Check the amount before assigning this document.',
	};
	readonly amountLabels: Record<MatchCandidateView['signals']['amount'], string> = {
		equal: 'Amounts match.',
		close: 'Amounts are close, with a difference to review.',
		different: 'Amounts differ.',
		'currency-differs': 'Currencies differ.',
		missing: 'No usable document amount.',
	};
	readonly nameLabels: Record<MatchCandidateView['signals']['filename']['state'], string> = {
		match: 'Name matches.',
		partial: 'Part of the name matches.',
		different: 'Names differ.',
		missing: 'No usable name comparison.',
	};
	readonly sectionLabels: Record<MatchCandidateView['sectionKind'], string> = {
		invoice: 'Invoice', receipt: 'Receipt', 'credit-note': 'Credit note', 'billing-summary': 'Billing summary',
		'payment-information': 'Payment information', unknown: 'Document section',
	};
	readonly date: (value: string | null, locale?: string | string[]) => string = formatCalendarDate;
	readonly money: (value: (Omit<Money, "currency"> & { currency: string | null; }) | null, locale?: string | string[]) => string = formatMoney;
	readonly round: (x: number) => number = Math.round;
	readonly basename: (filePath: string) => string = (filePath: string): string => {
        const name: string | undefined = filePath.split(/[\\/]/).at(-1);
        return name?.length ? name : filePath;
    };
	readonly transactionName: (description: string) => string = (description: string): string => {
		const firstLine: string = description.trim().split(/\r?\n/, 1)[0];
		return firstLine.length > 140 ? firstLine.slice(0, 139) + '…' : firstLine || 'Transaction';
	};
	readonly tableRow: (row: MatchSummary) => MatchSummary = (row: MatchSummary): MatchSummary => row;
	readonly transactionColumns: TableConfig<MatchSummary> = { columns: [
		{ field: 'approvalSelection', text: 'Approval selection', type: 'custom', template: 'approval' },
		{ field: 'bookingDate', text: 'Booking date', type: 'custom', template: 'date' },
		{ field: 'description', text: 'Transaction', type: 'custom', template: 'transaction' },
		{ field: 'accountAmount', text: 'Account amount', type: 'custom', template: 'amount' },
		{ field: 'review', text: 'Review / suggestion', type: 'custom', template: 'review' }
	] };
	readonly ignoredColumns: TableConfig<MatchSummary> = { columns: [
		{ field: 'bookingDate', text: 'Booking date', type: 'custom', template: 'date' },
		{ field: 'description', text: 'Transaction', type: 'custom', template: 'transaction' },
		{ field: 'accountAmount', text: 'Account amount', type: 'custom', template: 'amount' },
		{ field: 'ignoredByRule', text: 'Scope', type: 'custom', template: 'scope' },
		{ field: 'transactionId', text: 'Actions', type: 'custom', template: 'actions' }
	] };
	private readonly ignoreChoice: WritableSignal<{ transactionId: string; loadRevision: number; } | null> = signal<{ transactionId: string; loadRevision: number } | null>(null);
	private readonly ignoreFeedback: WritableSignal<{ loadRevision: number; message: string; } | null> = signal<{ loadRevision: number; message: string } | null>(null);
	private readonly ignoreFocus: WritableSignal<{ loadRevision: number; revision: number; headingId: string; } | null> = signal<{ loadRevision: number; revision: number; headingId: string } | null>(null);
	private readonly selected: WritableSignal<{ transactionId: string; loadRevision: number; } | null> = signal<{ transactionId: string; loadRevision: number } | null>(null);
	private readonly filterState: WritableSignal<{ filter: Filter; loadRevision: number; } | null> = signal<{ filter: Filter; loadRevision: number } | null>(null);
	private readonly summaryRequest: WritableSignal<{ revision: number; loadRevision: number; rows: MatchSummary[] | null; } | null> = signal<{ revision: number; loadRevision: number; rows: MatchSummary[] | null } | null>(null);
	private readonly detailRequest: WritableSignal<{ revision: number; transactionId: string; value: MatchDetails | null; } | null> = signal<{ revision: number; transactionId: string; value: MatchDetails | null } | null>(null);
	private readonly documentRequest: WritableSignal<{ key: string; documents: ReviewDocument[] | null; } | null> = signal<{ key: string; documents: ReviewDocument[] | null } | null>(null);
	private readonly documentRetry: WritableSignal<number> = signal(0);
	private readonly documentKey: Signal<string> = computed((): string => {
		const workspace: WorkspaceView = this.workspace();
		return JSON.stringify([workspace.loadRevision, workspace.matchRevision]);
	});
	private readonly documentDraft: WritableSignal<{ loadRevision: number; transactionId: string; id: string; } | null> = signal<{ loadRevision: number; transactionId: string; id: string } | null>(null);
	private readonly pending: WritableSignal<boolean> = signal(false);
	private readonly batchSelection: WritableSignal<{ loadRevision: number; rows: ReadonlyMap<string, MatchApprovalSelection>; } | null> = signal<{ loadRevision: number; rows: ReadonlyMap<string, MatchApprovalSelection> } | null>(null);
	private readonly batchFeedback: WritableSignal<{ loadRevision: number; message: string; error: boolean; transactionId?: string; } | null> = signal<{ loadRevision: number; message: string; error: boolean; transactionId?: string } | null>(null);
	private readonly reviewFeedback: WritableSignal<{ loadRevision: number; transactionId: string; message: string; } | null> = signal<{ loadRevision: number; transactionId: string; message: string } | null>(null);
	private readonly summaryRetry: WritableSignal<number> = signal(0);
	private readonly detailRetry: WritableSignal<number> = signal(0);
	private readonly revision: Signal<number> = computed((): number => this.workspace().matchRevision);
	private readonly currentSummary: Signal<{ revision: number; loadRevision: number; rows: MatchSummary[] | null; } | null> = computed((): { revision: number; loadRevision: number; rows: MatchSummary[] | null; } | null => {
		const result: { revision: number; loadRevision: number; rows: MatchSummary[] | null; } | null = this.summaryRequest();
		return result?.revision === this.revision() ? result : null;
	});
	readonly filter: Signal<Filter> = computed((): Filter => this.filterState()?.loadRevision === this.workspace().loadRevision ? this.filterState()!.filter : 'all');
	private readonly allRows: Signal<MatchSummary[] | null> = computed((): MatchSummary[] | null => {
		const result: { revision: number; loadRevision: number; rows: MatchSummary[] | null; } | null = this.summaryRequest();
		return result?.loadRevision === this.workspace().loadRevision ? result.rows : null;
	});
	readonly rows: Signal<MatchSummary[] | null> = computed((): MatchSummary[] | null => this.allRows()?.filter((row: MatchSummary): boolean => !row.ignored) ?? null);
	readonly ignoredRows: Signal<MatchSummary[]> = computed((): MatchSummary[] => this.allRows()?.filter((row: MatchSummary): boolean => row.ignored) ?? []);
	readonly ignoreError: Signal<string | null> = computed((): string | null => {
		const feedback: { loadRevision: number; message: string; } | null = this.ignoreFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision ? feedback.message : null;
	});
	readonly summariesFailed: Signal<boolean> = computed((): boolean => this.currentSummary()?.rows === null);
	readonly counts: Signal<{ reliable: number; uncertain: number; unmatched: number; }> = computed((): { reliable: number; uncertain: number; unmatched: number; } => {
		const counts: { reliable: number; uncertain: number; unmatched: number; } = { reliable: 0, uncertain: 0, unmatched: 0 };
		for (const row of this.rows() ?? []) {
			counts[row.status]++;
		}
		return counts;
	});
	readonly filteredRows: Signal<MatchSummary[]> = computed((): MatchSummary[] => {
		const rows: MatchSummary[] = this.rows() ?? [];
		const filter: Filter = this.filter();
		return filter === 'all' ? rows : rows.filter((row: MatchSummary): boolean => row.status === filter);
	});
	readonly selectedRow: Signal<MatchSummary | null> = computed<MatchSummary | null>((): MatchSummary => {
		const rows: MatchSummary[] = this.filteredRows();
		const selected: { transactionId: string; loadRevision: number; } | null = this.selected();
		const id: string | null = selected?.loadRevision === this.workspace().loadRevision ? selected.transactionId : null;
		return rows.find((row: MatchSummary): boolean => row.transactionId === id) ?? rows[0] ?? null;
	});
	readonly choosingIgnore: Signal<boolean> = computed((): boolean => {
		const choice: { transactionId: string; loadRevision: number; } | null = this.ignoreChoice();
		return choice?.loadRevision === this.workspace().loadRevision && choice.transactionId === this.selectedRow()?.transactionId;
	});
	readonly reviewDisabled: Signal<boolean> = computed((): boolean => this.busy() || this.pending() || !this.currentSummary()?.rows);
	readonly approvalSelections: Signal<ReadonlyMap<string, MatchApprovalSelection> | null> = computed((): ReadonlyMap<string, MatchApprovalSelection> | null => {
		const selection: { loadRevision: number; rows: ReadonlyMap<string, MatchApprovalSelection>; } | null = this.batchSelection();
		return selection?.loadRevision === this.workspace().loadRevision ? selection.rows : null;
	});
	readonly hiddenApprovalCount: Signal<number> = computed((): number => {
		const selected: ReadonlyMap<string, MatchApprovalSelection> | null = this.approvalSelections();
		return selected ? selected.size - this.filteredRows().filter((row: MatchSummary): boolean => selected.has(row.transactionId)).length : 0;
	});
	readonly approvalFeedback: Signal<{ loadRevision: number; message: string; error: boolean; transactionId?: string; } | null> = computed((): { loadRevision: number; message: string; error: boolean; transactionId?: string; } | null => {
		const feedback: { loadRevision: number; message: string; error: boolean; transactionId?: string; } | null = this.batchFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision ? feedback : null;
	});
	readonly reviewError: Signal<string | null> = computed((): string | null => {
		const feedback: { loadRevision: number; transactionId: string; message: string; } | null = this.reviewFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision && feedback.transactionId === this.selectedRow()?.transactionId ? feedback.message : null;
	});
	readonly documents: Signal<ReviewDocument[] | null> = computed((): ReviewDocument[] | null => this.documentRequest()?.key === this.documentKey() ? this.documentRequest()!.documents : null);
	readonly documentsFailed: Signal<boolean> = computed((): boolean => this.documentRequest()?.key === this.documentKey() && this.documentRequest()?.documents === null);
	readonly duplicateDocumentNames: Signal<Set<string>> = computed((): Set<string> => {
		const seen: Set<string> = new Set<string>();
		const duplicates: Set<string> = new Set<string>();
		for (const { name } of this.documents() ?? []) {
			if (seen.has(name)) {
				duplicates.add(name);
			}
			seen.add(name);
		}
		return duplicates;
	});
	readonly owners: Signal<Map<string, MatchSummary>> = computed((): Map<string, MatchSummary> => new Map((this.allRows() ?? []).flatMap((row: MatchSummary): [] | [readonly [string, MatchSummary]] => row.review.status === 'assigned' ? [[row.review.documentId, row] as const] : [])));
	readonly documentOptions: Signal<{ id: string; label: string; disabled: boolean; }[]> = computed((): { id: string; label: string; disabled: boolean; }[] => {
		const transaction: string | undefined = this.selectedRow()?.transactionId;
		const owners: Map<string, MatchSummary> = this.owners();
		return (this.documents() ?? []).map((item: ReviewDocument): { id: string; label: string; disabled: boolean; } => {
			const owner: MatchSummary | undefined = owners.get(item.id);
			const unavailable: boolean | undefined = owner && owner.transactionId !== transaction;
			return { id: item.id, label: this.documentLabel(item, unavailable ? owner : undefined), disabled: !!unavailable };
		});
	});
	readonly assignedDocument: Signal<ReviewDocument | null | undefined> = computed((): ReviewDocument | null | undefined => {
		const review: { status: "open"; } | { status: "assigned"; documentId: string; } | { status: "completed-without-document"; } | undefined = this.selectedRow()?.review;
		return review?.status === 'assigned' ? this.documents()?.find((item: ReviewDocument): boolean => item.id === review.documentId) : null;
	});
	readonly selectedDocumentId: Signal<string> = computed((): string => {
		const draft: { loadRevision: number; transactionId: string; id: string; } | null = this.documentDraft();
		if (draft?.loadRevision === this.workspace().loadRevision && draft.transactionId === this.selectedRow()?.transactionId) {
			return draft.id;
		}
		return this.assignedDocument()?.id ?? '';
	});
	readonly selectedDocument: Signal<ReviewDocument | undefined> = computed((): ReviewDocument | undefined => this.documents()?.find((item: ReviewDocument): boolean => item.id === this.selectedDocumentId()));
	private readonly candidateTransactionId: Signal<string | null> = computed((): string | null => {
		const row: MatchSummary | null = this.selectedRow();
		return row?.candidateCount ? row.transactionId : null;
	});
	private readonly currentDetail: Signal<{ revision: number; transactionId: string; value: MatchDetails | null; } | null> = computed((): { revision: number; transactionId: string; value: MatchDetails | null; } | null => {
		const result: { revision: number; transactionId: string; value: MatchDetails | null; } | null = this.detailRequest();
		return result?.revision === this.revision() && result.transactionId === this.candidateTransactionId() ? result : null;
	});
	readonly details: Signal<MatchDetails | null> = computed((): MatchDetails | null => this.currentDetail()?.value ?? null);
	readonly detailsFailed: Signal<boolean> = computed((): boolean => this.currentDetail()?.value === null);

	constructor() {
		effect((): void => {
			const focus: { loadRevision: number; revision: number; headingId: string; } | null = this.ignoreFocus();
			if (!focus || !this.active() || focus.loadRevision !== this.workspace().loadRevision || (this.currentSummary()?.revision ?? -1) < focus.revision) {
				return;
			}
			this.ignoreFocus.set(null);
			requestAnimationFrame((): void => {
				if (this.active() && focus.loadRevision === this.workspace().loadRevision) {
					document.getElementById(focus.headingId)?.focus();
				}
			});
		});

		effect((onCleanup: EffectCleanupRegisterFn): void => {
			const matchRevision: number = this.revision();
			this.summaryRetry();
			if (!this.active() || untracked((): { revision: number; loadRevision: number; rows: MatchSummary[] | null; } | null => this.currentSummary())) {
				return;
			}
			const loadRevision: number = untracked((): number => this.workspace().loadRevision);
			let current: boolean = true;
			onCleanup((): void => {
				current = false;
			});
			const update: (rows: MatchSummary[] | null) => void = (rows: MatchSummary[] | null): void => {
					if (!current || !this.active() || this.revision() !== matchRevision) {
						return;
					}
				this.summaryRequest.set({ revision: matchRevision, loadRevision, rows });
				const selection: { loadRevision: number; rows: ReadonlyMap<string, MatchApprovalSelection>; } | null = this.batchSelection();
				if (selection?.loadRevision !== loadRevision || !selection.rows.size) {
					return;
				}
				const remaining: Map<string, MatchApprovalSelection> = new Map(selection.rows);
				for (const row of rows ?? []) {
					if (row.ignored) {
						remaining.delete(row.transactionId);
					}
				}
				if (remaining.size !== selection.rows.size) {
					this.batchSelection.set({ loadRevision, rows: remaining });
				}
			};
			void window.receiptmatch.matchSummaries(matchRevision).then(update, (): void => update(null));
		});

		effect((onCleanup: EffectCleanupRegisterFn): void => {
			const transactionId: string | null = this.candidateTransactionId();
			const matchRevision: number = this.revision();
			this.detailRetry();
			if (!this.active() || !transactionId || untracked((): { revision: number; transactionId: string; value: MatchDetails | null; } | null => this.currentDetail())) {
				return;
			}
			let current: boolean = true;
			onCleanup((): void => {
				current = false;
			});
			const update: (value: MatchDetails | null) => void = (value: MatchDetails | null): void => {
				if (current && this.active() && this.revision() === matchRevision && this.candidateTransactionId() === transactionId) {
					this.detailRequest.set({ revision: matchRevision, transactionId, value });
				}
			};
			void window.receiptmatch.matchDetails(matchRevision, transactionId).then(update, (): void => update(null));
		});

		effect((onCleanup: EffectCleanupRegisterFn): void => {
			const key: string = this.documentKey();
			this.documentRetry();
			if (!this.active() || untracked((): boolean => this.documentRequest()?.key === key)) {
				return;
			}
			const { documentImports, loadRevision, matchRevision, supersededDocuments }: WorkspaceView = untracked(this.workspace);
			const reportIds: string[] = documentImports.map((report: DocumentImportSummary): string => report.id);
			if (!reportIds.length) {
				this.documentRequest.set({ key, documents: [] }); return;
			}
			let current: boolean = true;
			onCleanup((): void => {
				current = false;
			});
			const update: (documents: ReviewDocument[] | null) => void = (documents: ReviewDocument[] | null): void => {
				if (current && this.active() && this.documentKey() === key) {
					this.documentRequest.set({ key, documents });
				}
			};
			void window.receiptmatch.documentSnapshot({ loadRevision, revision: matchRevision }).then((snapshot: DocumentSnapshot | null): void => {
				if (snapshot?.loadRevision !== loadRevision || snapshot.revision !== matchRevision) {
					return update(null);
				}
				const records: StoredDocumentImport[] = snapshot.reports;
				if (records.length !== reportIds.length || records.some((record: StoredDocumentImport, index: number): boolean => record.id !== reportIds[index])) {
					return update(null);
				}
				const archived: Set<string> = new Set(supersededDocuments);
				const documents: ReviewDocument[] = records.flatMap((record: StoredDocumentImport): ReviewDocument[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): ReviewDocument[] => file.status === 'imported' && !archived.has(file.record.id) ? [{
					id: file.record.id, name: this.basename(file.record.filePath), path: file.record.filePath, total: formatDocumentTotal(file.record.result), record: file.record,
				}] : []));
				update(documents.sort((a: ReviewDocument, b: ReviewDocument): number => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)));
			}).catch((): void => update(null));
		});
	}

	setFilter(filter: Filter): void {
		const previous: string | undefined = this.selectedRow()?.transactionId;
		this.filterState.set({ filter, loadRevision: this.workspace().loadRevision });
		if (previous !== this.selectedRow()?.transactionId) {
			this.resetDetail();
		}
	}

	selectTransaction(event: MouseEvent): void {
		const target: EventTarget | null = event.target;
		if (!(target instanceof Element) || target.closest('wig-checkbox')) {
			return;
		}
		const transactionId: string | undefined = target.closest('tbody tr')?.querySelector<HTMLElement>('[data-transaction-id]')?.dataset.transactionId;
		if (!transactionId) {
			return;
		}
		const { loadRevision }: WorkspaceView = this.workspace();
		if (transactionId !== this.selectedRow()?.transactionId) {
			this.resetDetail();
		}
		this.selected.set({ transactionId, loadRevision });
		const stacked: boolean = window.matchMedia('(width < 1000px)').matches;
		if (event.detail === 0 || stacked) {
			requestAnimationFrame((): void => {
			if (this.active() && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId) {
				document.getElementById('match-detail-heading')?.focus({ preventScroll: !stacked });
			}
		});
		}
	}

	toggleIgnoreChoice(): void {
		const row: MatchSummary | null = this.selectedRow();
		this.ignoreFeedback.set(null);
		this.ignoreChoice.set(row && !this.choosingIgnore() ? { transactionId: row.transactionId, loadRevision: this.workspace().loadRevision } : null);
	}

	async changeIgnored(row: MatchSummary, ignored: boolean, remember?: true): Promise<void> {
		if (this.reviewDisabled()) {
			return;
		}
		const { loadRevision, matchRevision }: WorkspaceView = this.workspace();
		this.pending.set(true);
		this.ignoreFeedback.set(null);
		try {
			const result: WorkspaceState = await window.receiptmatch.command({
				type: 'set-transaction-ignored', transactionId: row.transactionId, revision: matchRevision, ignored, ...(remember && { remember }),
			});
			if (this.workspace().loadRevision !== loadRevision) {
				return;
			}
			if (result.error) {
				if (result.busy) {
					this.ignoreFeedback.set({ loadRevision, message: result.error });
				}
				return;
			}
			this.ignoreChoice.set(null);
			this.documentDraft.set(null);
			if (!ignored) {
				this.setFilter('all');
				this.selected.set({ transactionId: row.transactionId, loadRevision });
			}
			this.ignoreFocus.set({ loadRevision, revision: result.workspace?.matchRevision ?? matchRevision,
				headingId: ignored ? 'match-ignored-heading' : 'match-list-heading' });
		} catch {
			this.ignoreFeedback.set({ loadRevision, message: 'The ignore decision could not be saved. Please try again.' });
		} finally {
			this.pending.set(false);
		}
	}

	private resetDetail(): void {
		const panel: HTMLElement | null = document.getElementById('match-detail-panel');
		if (panel) {
			panel.scrollTop = 0;
		}
	}

	focusSelectedTransaction(transactionId: string): void {
		document.getElementById('match-transaction-' + transactionId)?.closest('tr')?.focus();
	}

	documentLabel(item: ReviewDocument, owner?: MatchSummary): string {
		const parts: string[] = [this.duplicateDocumentNames().has(item.name) ? item.path : item.name];
		if (item.total) {
			parts.push(item.total);
		}
		if (owner) {
			parts.push('Assigned to ' + this.transactionName(owner.description));
		}
		return parts.join(' · ');
	}

	chooseDocument(id: string | null): void {
		const row: MatchSummary | null = this.selectedRow();
		if (row) {
			this.documentDraft.set({ loadRevision: this.workspace().loadRevision, transactionId: row.transactionId, id: id ?? '' });
		}
	}

	selectForApproval(row: MatchSummary, checked: boolean): void {
		if (this.reviewDisabled()) {
			return;
		}
		const rows: Map<string, MatchApprovalSelection> = new Map(this.approvalSelections());
		if (!checked) {
			rows.delete(row.transactionId);
		} else if (row.approvalSelection && !row.approval) {
			rows.set(row.transactionId, row.approvalSelection);
		}
		this.batchSelection.set({ loadRevision: this.workspace().loadRevision, rows });
		this.batchFeedback.set(null);
	}

	clearApprovalSelection(): void {
		this.batchSelection.set(null);
		this.batchFeedback.set(null);
		document.getElementById('match-list-heading')?.focus({ preventScroll: true });
	}

	async approveSelected(): Promise<void> {
		const selected: ReadonlyMap<string, MatchApprovalSelection> | null = this.approvalSelections();
		if (!selected?.size || this.reviewDisabled()) {
			return;
		}
		const { loadRevision }: WorkspaceView = this.workspace();
		const trigger: Element | null = document.activeElement;
		let focusId: string = 'match-batch-result';
		this.pending.set(true);
		this.batchFeedback.set(null);
		try {
			const result: WorkspaceState = await window.receiptmatch.command({ type: 'approve-matches', loadRevision, selections: [...selected.values()] });
			if (this.workspace().loadRevision !== loadRevision) {
				return;
			}
			if (result.error) {
				focusId = this.reportApprovalError(selected, loadRevision, result, result.error);
			} else {
				this.batchSelection.set(null);
				this.batchFeedback.set({ loadRevision, message: 'Selected transactions approved.', error: false });
			}
		} catch {
			this.batchFeedback.set({ loadRevision, message: 'The selected transactions could not be approved. Try again.', error: true });
		} finally {
			this.pending.set(false);
			requestAnimationFrame((): void => {
				if (!this.active() || this.workspace().loadRevision !== loadRevision || (document.activeElement !== trigger && document.activeElement !== document.body)) {
					return;
				}
				const element: HTMLElement | null = document.getElementById(focusId);
				const target: HTMLElement | null | undefined = focusId === 'match-batch-result' ? element : element?.closest('tr');
				target?.focus({ preventScroll: true });
				if (focusId !== 'match-batch-result') {
					target?.scrollIntoView({ block: 'center', inline: 'nearest' });
				}
			});
		}
	}

	private reportApprovalError(selected: ReadonlyMap<string, MatchApprovalSelection>, loadRevision: number, result: WorkspaceState, error: string): string {
		let focusId: string = 'match-batch-result';
		const transactionId: string | undefined = result.approvalIssue?.transactionId;
		if (transactionId) {
			const remaining: Map<string, MatchApprovalSelection> = new Map(selected);
			remaining.delete(transactionId);
			this.batchSelection.set({ loadRevision, rows: remaining });
			if (this.rows()?.some((row: MatchSummary): boolean => row.transactionId === transactionId)) {
				if (!this.filteredRows().some((row: MatchSummary): boolean => row.transactionId === transactionId)) {
					this.setFilter('all');
				}
				if (this.selectedRow()?.transactionId !== transactionId) {
					this.resetDetail();
				}
				this.selected.set({ transactionId, loadRevision });
				focusId = 'match-transaction-' + transactionId;
			}
		}
		if (transactionId || result.busy) {
			this.batchFeedback.set({ loadRevision, message: error, error: true, transactionId });
		}
		return focusId;
	}

	async applyReview(review: MatchReview): Promise<void> {
		const row: MatchSummary | null = this.selectedRow();
		if (this.reviewDisabled() || !row) {
			return;
		}
		const { transactionId }: MatchSummary = row;
		const { loadRevision, matchRevision }: WorkspaceView = this.workspace();
		const trigger: Element | null = document.activeElement;
		this.pending.set(true);
		this.reviewFeedback.set(null);
		try {
			const result: WorkspaceState = await window.receiptmatch.command({ type: 'review-match', transactionId, revision: matchRevision, review });
			// The session publishes validation errors. It returns busy rejections only to this caller.
			if (result.busy && result.error) {
				this.reviewFeedback.set({ loadRevision, transactionId, message: result.error });
			}
			if (!result.error && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId) {
				this.documentDraft.set(null);
			}
		} catch {
			this.reviewFeedback.set({ loadRevision, transactionId, message: 'The review decision could not be recorded. Please try again.' });
		} finally {
			this.pending.set(false);
			requestAnimationFrame((): void => {
				if (this.active() && this.workspace().loadRevision === loadRevision && this.selectedRow()?.transactionId === transactionId &&
					(document.activeElement === trigger || document.activeElement === document.body)) {
					document.getElementById('match-review-heading')?.focus();
				}
			});
		}
	}

	retryDocuments(): void {
		this.documentRequest.set(null); this.documentRetry.update((value: number): number => value + 1);
	}

	retrySummaries(): void {
		this.summaryRequest.set(null); this.summaryRetry.update((value: number): number => value + 1);
	}

	retryDetails(): void {
		this.detailRequest.set(null); this.detailRetry.update((value: number): number => value + 1);
	}
}
