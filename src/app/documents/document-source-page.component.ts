import { Component, computed, input, signal, type InputSignal, type Signal, type WritableSignal } from '@angular/core';
import { WigButtonComponent } from '@wigtertainment-ltd/comp-lib';
import type { ImportPage, PositionedSpan } from '../../shared/bank-import.js';
import { extractionLabels, regionText } from './document-evidence.js';

@Component({
    selector: 'app-document-source-page', standalone: true, imports: [WigButtonComponent],
    templateUrl: './document-source-page.component.html'
})
export class DocumentSourcePage {
    readonly page: InputSignal<ImportPage> = input.required<ImportPage>();
    readonly units: InputSignal<string> = input.required<string>();
    readonly initiallyOpen: InputSignal<boolean> = input(false);
    private readonly opened: WritableSignal<boolean | null> = signal<boolean | null>(null);
    private readonly limit: WritableSignal<number> = signal(100);
    readonly isOpen: Signal<boolean> = computed((): boolean => this.opened() ?? this.initiallyOpen());
    readonly spans: Signal<PositionedSpan[]> = computed((): PositionedSpan[] => this.page().spans.slice(0, this.limit()));
    readonly remaining: Signal<number> = computed((): number => this.page().spans.length - this.spans().length);
    readonly nextCount: Signal<number> = computed((): number => Math.min(this.remaining(), 100));
    readonly extractionLabels: typeof extractionLabels = extractionLabels;
    readonly regionText: ({ x, y, width, height }: PositionedSpan["region"]) => string = regionText;
    toggle(event: Event): void {
        this.opened.set((event.target as HTMLDetailsElement).open);
    }

    showMore(): void {
        this.limit.update((value: number): number => value + 100);
    }
}
