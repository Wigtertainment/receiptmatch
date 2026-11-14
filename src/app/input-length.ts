import { afterNextRender, Directive, ElementRef, inject, input, Renderer2, type InputSignal } from '@angular/core';

@Directive({ selector: 'wig-input[appInputLength]' })
export class InputLength {
  readonly appInputLength: InputSignal<number> = input.required<number>();
  readonly appDisableSpellcheck: InputSignal<boolean> = input(false);

  constructor() {
    const host: HTMLElement = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const renderer: Renderer2 = inject(Renderer2);
    afterNextRender((): void => {
      const field: HTMLInputElement | null = host.querySelector('input');
      if (!field) {
        return;
      }
      renderer.setProperty(field, 'maxLength', this.appInputLength());
      if (this.appDisableSpellcheck()) {
        renderer.setProperty(field, 'spellcheck', false);
      }
    });
  }
}
