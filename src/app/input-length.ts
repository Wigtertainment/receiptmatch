import { afterNextRender, Directive, ElementRef, inject, input, Renderer2 } from '@angular/core';

@Directive({ selector: 'wig-input[appInputLength]' })
export class InputLength {
  readonly appInputLength = input.required<number>();
  readonly appDisableSpellcheck = input(false);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const renderer = inject(Renderer2);
    afterNextRender(() => {
      const field = host.querySelector('input');
      if (!field) return;
      renderer.setProperty(field, 'maxLength', this.appInputLength());
      if (this.appDisableSpellcheck()) renderer.setProperty(field, 'spellcheck', false);
    });
  }
}
