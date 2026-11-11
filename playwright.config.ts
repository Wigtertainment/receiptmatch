import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/*.spec.ts',
	outputDir: './artifacts/playwright',
	workers: 1,
	reporter: [['list', { printSteps: true }]]
});
