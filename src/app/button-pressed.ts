import { afterRenderEffect, Directive, inject, input, Renderer2 } from '@angular/core';
import { WigButtonComponent } from '@wigtertainment-ltd/comp-lib';

@Directive({ selector: 'wig-button[appButtonPressed]' })
export class ButtonPressed {
	readonly appButtonPressed = input.required<boolean>();

	constructor() {
		const button = inject(WigButtonComponent, { self: true });
		const renderer = inject(Renderer2);
		afterRenderEffect({ write: () => renderer.setAttribute(button.nativeButton, 'aria-pressed', String(this.appButtonPressed())) });
	}
}
