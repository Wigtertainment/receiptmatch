import { Component } from '@angular/core';

@Component({
	selector: 'app-local-ai-icon',
	standalone: true,
	styles: ':host { display: inline-flex; }',
	template: `
		<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round">
			<path d="M10 2.5 12.2 8.8 18.5 11l-6.3 2.2-2.2 6.3-2.2-6.3L1.5 11l6.3-2.2L10 2.5ZM19 14.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" />
		</svg>
	`
})
export class LocalAiIcon {}
