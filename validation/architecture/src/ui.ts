import { Component, afterNextRender, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

declare global { interface Window { validation: { ready(value: unknown): Promise<void> }; } }

@Component({ selector: 'app-validation-root', standalone: true, template: '<h1>ReceiptMatch architecture validation</h1><p>Synthetic fixtures only</p><output>{{ ticks() }}</output>' })
class ValidationApp {
  readonly ticks = signal(0);
  constructor() {
    setInterval(() => this.ticks.update(value => value + 1), 50);
    afterNextRender(() => void window.validation.ready({ angular: true, node: typeof (globalThis as unknown as { require?: unknown }).require !== 'undefined' }));
  }
}

bootstrapApplication(ValidationApp).catch(error => { document.body.textContent = String(error); });
