import { afterRenderEffect, Directive, inject, input, Renderer2, type InputSignal } from '@angular/core';
import { WigButtonComponent } from '@wigtertainment-ltd/comp-lib';

@Directive({ selector: 'wig-button[appButtonPressed]' })
export class ButtonPressed {
	readonly appButtonPressed: InputSignal<boolean> = input.required<boolean>();

	constructor() {
		const button: WigButtonComponent = inject(WigButtonComponent, { self: true });
		const renderer: Renderer2 = inject(Renderer2);
		afterRenderEffect({ write: (): void => renderer.setAttribute(button.nativeButton, 'aria-pressed', String(this.appButtonPressed())) });
	}
}
