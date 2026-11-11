import { Component, computed, input, signal } from '@angular/core';

@Component({
    selector: 'app-original-preview-button',
    standalone: true,
    template: `
      <button type="button" class="button-secondary compact" [attr.aria-label]="'Open original ' + sourceName()"
        [attr.aria-busy]="feedback()?.pending || null"
        [attr.aria-disabled]="feedback()?.pending || loadRevision() === undefined ? 'true' : null" (click)="open()">
        {{ feedback()?.pending ? 'Opening…' : 'Open original' }}
      </button>
      @if (feedback()?.error; as error) {
        <p class="original-preview-error" role="alert">{{ error }}</p>
      }
    `
})
export class OriginalPreviewButton {
    readonly kind = input.required<'statement' | 'document'>();
    readonly sourceId = input.required<string>();
    readonly sourceName = input.required<string>();
    readonly loadRevision = input.required<number | undefined>();
    private readonly request = signal<{ id: string; loadRevision: number; pending: boolean; error: string | null } | null>(null);
    readonly feedback = computed(() => {
        const request = this.request();
        return request?.id === this.sourceId() && request.loadRevision === this.loadRevision() ? request : null;
    });

    async open() {
        const loadRevision = this.loadRevision();
        if (loadRevision === undefined || this.feedback()?.pending) return;
        const request = { id: this.sourceId(), loadRevision, pending: true, error: null };
        this.request.set(request);
        try {
            const { error } = await window.receiptmatch.openOriginal({ kind: this.kind(), id: request.id, loadRevision });
            if (this.request() === request) this.request.set({ ...request, pending: false, error });
        } catch {
            if (this.request() === request) this.request.set({ ...request, pending: false, error: 'The original could not be opened. Try again.' });
        }
    }
}
