import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type ElectronApplication } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { statement } from '../unit/bank-fixtures.js';

async function statementPdf(file: string) {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const input of statement().pages) {
		const page = pdf.addPage([input.width, input.height]);
		for (const span of input.spans) page.drawText(span.text, { x: span.region.x, y: input.height - span.region.y - 10, size: 10, font });
	}
	await writeFile(file, await pdf.save());
}

async function invoicePdf(file: string, total: string) {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const page = pdf.addPage([600, 800]);
	const lines = ['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-03-06', `Invoice Total: ${total}`];
	for (const [index, text] of lines.entries()) page.drawText(text, { x: 40, y: 740 - index * 30, size: 14, font });
	await writeFile(file, await pdf.save());
}

async function dialogs(app: ElectronApplication, opens: string[], save = '') {
	await app.evaluate(({ dialog, BrowserWindow }, plan) => {
		BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
		dialog.showOpenDialog = async () => {
			const file = plan.opens.shift();
			return { canceled: !file, filePaths: file ? [file] : [] };
		};
		dialog.showSaveDialog = async () => ({ canceled: !plan.save, filePath: plan.save });
		dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
	}, { opens, save });
}

test('packaged match suggestions from import through keyboard review and reopening', async ({ playwright }, testInfo) => {
	test.setTimeout(120_000);
	const root = testInfo.outputPath('workspace');
	const first = path.join(root, 'documents');
	const second = path.join(root, 'more-documents');
	const bankFile = path.join(root, 'statement.pdf');
	const workspaceFile = path.join(root, 'reconciliation.receiptmatch');
	await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
	await Promise.all([statementPdf(bankFile), invoicePdf(path.join(first, 'account-invoice.pdf'), 'EUR 1,234.56'),
		invoicePdf(path.join(second, 'original-invoice.pdf'), 'USD 1,500.01')]);
	async function launch(profile: string) {
		return playwright._electron.launch({
			executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
			args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, profile)}`],
		});
	}
	let app = await launch('first-profile');
	try {
		const page = await app.firstWindow();
		await dialogs(app, [bankFile, first, second], workspaceFile);
		await page.getByRole('button', { name: 'Create workspace' }).click();
		const nav = page.getByRole('navigation', { name: 'Workspace views' });
		const sourcesNav = nav.getByRole('button', { name: 'Sources' });
		const matchesNav = nav.getByRole('button', { name: 'Match suggestions' });
		const matches = page.getByRole('region', { name: 'Match suggestions' });
		const filters = matches.getByRole('group', { name: 'Filter match results' });
		const list = matches.getByRole('region', { name: 'Transactions', exact: true });
		const detail = matches.locator('#match-detail-panel');
		await expect(sourcesNav).toHaveAttribute('aria-current', 'page');
		await matchesNav.press('Enter');
		await expect(matchesNav).toHaveAttribute('aria-current', 'page');
		await expect(matches.getByRole('heading', { name: 'Match suggestions' })).toBeFocused();
		await expect(matches.getByText('Import a bank statement', { exact: false })).toBeVisible();
		await sourcesNav.click();
		await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeFocused();
		await page.getByRole('button', { name: 'Import statement' }).click();
		await matchesNav.click();
		await expect(filters.getByRole('button', { name: 'Unmatched 2' })).toBeVisible();
		await filters.getByRole('button', { name: 'Reliable 0' }).click();
		await expect(matches.getByText('No transactions with this result.')).toBeVisible();
		await filters.getByRole('button', { name: 'All 2' }).click();
		await sourcesNav.click();
		await page.getByRole('button', { name: 'Choose folder' }).click();
		const statements = page.getByRole('region', { name: 'Bank statements' });
		const documents = page.getByRole('region', { name: 'Supporting documents' });
		await expect(documents.getByText('Analysis finished.', { exact: true })).toBeVisible();
		const resize = async (width: number) => {
			await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
			await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
		};
		const importBounds = async () => {
			const [bank, receipts] = await Promise.all([statements.boundingBox(), documents.boundingBox()]);
			return { leftToRight: bank!.x + bank!.width < receipts!.x && bank!.y === receipts!.y, topToBottom: bank!.y + bank!.height < receipts!.y };
		};
		await resize(1120);
		await expect.poll(async () => (await importBounds()).leftToRight).toBe(true);
		await expect.poll(() => statements.getByRole('region', { name: 'Transactions table, horizontally scrollable' }).evaluate(table => table.scrollWidth <= table.clientWidth)).toBe(true);
		await resize(1020);
		await expect.poll(async () => (await importBounds()).topToBottom).toBe(true);
		await resize(680);
		await expect.poll(async () => (await importBounds()).topToBottom).toBe(true);
		await resize(1120);
		await matchesNav.click();
		await expect(filters.getByRole('button', { name: 'Reliable 1' })).toBeVisible();
		const orchard = list.getByRole('button', { name: /Orchard Workshop/ });
		await orchard.press('Enter');
		await expect(orchard).toHaveAttribute('aria-pressed', 'true');
		await expect(detail.getByRole('heading', { name: /Orchard Workshop/ })).toBeFocused();
		await expect(detail.getByRole('heading', { name: 'account-invoice.pdf' })).toBeVisible();
		await expect.poll(async () => {
			const [transactions, evidence] = await Promise.all([list.boundingBox(), detail.boundingBox()]);
			return transactions!.x + transactions!.width < evidence!.x && transactions!.y === evidence!.y;
		}).toBe(true);
		await expect(matches.getByText('7 days apart (within 7 days)', { exact: false })).toBeVisible();
		await matches.locator('summary').filter({ hasText: 'Source evidence' }).press('Enter');
		await expect(matches.getByText('Invoice Number: SYNTHETIC-A')).toBeVisible();

		await sourcesNav.click();
		await page.getByRole('button', { name: 'Choose folder' }).click();
		await matchesNav.click();
		await expect(filters.getByRole('button', { name: 'Uncertain 1' })).toBeVisible();
		await resize(680);
		await filters.getByRole('button', { name: 'Unmatched 1' }).click();
		await expect(filters.getByRole('button', { name: 'Unmatched 1' })).toHaveAttribute('aria-pressed', 'true');
		await expect(matches.getByRole('row', { name: /River Studio/ })).toBeVisible();
		await expect(matches.getByRole('row', { name: /Orchard Workshop/ })).toHaveCount(0);
		const river = list.getByRole('button', { name: /River Studio/ });
		await river.click();
		await expect(detail.getByRole('heading', { name: /River Studio/ })).toBeFocused();
		await expect(detail.getByText('No supporting document met the matching rules for this transaction.')).toBeVisible();
		const [transactions, evidence] = await Promise.all([list.boundingBox(), detail.boundingBox()]);
		expect(transactions!.y + transactions!.height).toBeLessThan(evidence!.y);
		await detail.getByRole('button', { name: 'Back to transactions' }).press('Enter');
		await expect(river).toBeFocused();
		await filters.getByRole('button', { name: 'Uncertain 1' }).click();
		await expect(matches.getByRole('heading', { name: 'original-invoice.pdf' })).toBeVisible();
		await expect(matches.getByText('Reported original payment amount', { exact: true })).toBeVisible();
		await expect(matches.getByText('Another possible match is supported by a reference.')).toHaveCount(2);
		await test.step('persist manual decisions through the workspace bridge independently of suggestions', async () => {
			const state = await page.evaluate(async () => {
				const bridge = window.receiptmatch;
				const { workspace } = await bridge.command({ type: 'get-state' });
				const rows = (await bridge.matchSummaries(workspace!.matchRevision))!;
				const matched = rows.find(row => row.status === 'uncertain')!;
				const unmatched = rows.find(row => row.status === 'unmatched')!;
				const { candidates } = (await bridge.matchDetails(workspace!.matchRevision, matched.transactionId))!;
				const assigned = await bridge.command({ type: 'review-match', revision: workspace!.matchRevision, transactionId: unmatched.transactionId,
					review: { status: 'assigned', documentId: candidates[0].documentId } });
				if (assigned.error) throw new Error(assigned.error);
				return bridge.command({ type: 'review-match', revision: assigned.workspace!.matchRevision, transactionId: matched.transactionId,
					review: { status: 'completed-without-document' } });
			});
			expect(state.error).toBeNull();
			expect(state.workspace?.matchReviewCounts).toEqual({ open: 0, assigned: 1, 'completed-without-document': 1 });
		});
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		await app.close();

		app = await launch('second-profile');
		const reopened = await app.firstWindow();
		await dialogs(app, [workspaceFile]);
		await reopened.getByRole('button', { name: 'Open workspace', exact: false }).click();
		const restoredNav = reopened.getByRole('navigation', { name: 'Workspace views' });
		await expect(restoredNav.getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-current', 'page');
		await restoredNav.getByRole('button', { name: 'Match suggestions' }).click();
		const restored = reopened.getByRole('region', { name: 'Match suggestions' });
		await restored.getByRole('group', { name: 'Filter match results' }).getByRole('button', { name: 'Uncertain 1' }).click();
		await expect(restored.getByRole('heading', { name: 'original-invoice.pdf' })).toBeVisible();
		await expect(restored.getByText('Matching reference', { exact: true })).toHaveCount(2);
		const decisions = await reopened.evaluate(async () => {
			const bridge = window.receiptmatch;
			const { workspace } = await bridge.command({ type: 'get-state' });
			const rows = await bridge.matchSummaries(workspace!.matchRevision);
			return rows?.map(row => [row.status, row.review.status]).sort();
		});
		expect(decisions).toEqual([['uncertain', 'completed-without-document'], ['unmatched', 'assigned']]);
	} finally { await app.close(); }
});
