import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: '**/*.spec.ts',
	outputDir: '../../artifacts/playwright-development',
	workers: 1,
	reporter: [['list', { printSteps: true }]]
});
