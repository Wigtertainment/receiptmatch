import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect, type ElectronApplication } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { airwallexStatement } from '../unit/airwallex-fixtures.js';
import { row, span, statement } from '../unit/bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank } from '../unit/document-fixtures.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';

async function statementPdf(file: string) {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const input of statement().pages) {
		const page = pdf.addPage([input.width, input.height]);
		const spans = [...input.spans.filter(span => span.region.y !== 285), ...row(285, '27 Feb 2032', 'To: River Studio', '256.20', null)];
		for (const span of spans) page.drawText(span.text, { x: span.region.x, y: input.height - span.region.y - 10, size: 10, font });
	}
	await writeFile(file, await pdf.save());
}

async function invoicePdf(file: string, total: string, receipt = false) {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const page = pdf.addPage([600, 800]);
	const lines = receipt ? ['Receipt', 'Merchant: River Studio', 'Issue Date: 2032-02-27', `Total: ${total}`] :
		['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-03-06', `Invoice Total: ${total}`];
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
	test.setTimeout(180_000);
	const root = testInfo.outputPath('workspace');
	const first = path.join(root, 'documents');
	const second = path.join(root, 'more-documents');
	const bankFile = path.join(root, 'statement.pdf');
	const workspaceFile = path.join(root, 'reconciliation.receiptmatch');
	await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
	await Promise.all([statementPdf(bankFile), invoicePdf(path.join(first, 'Orchard_Workshop_invoice.pdf'), 'EUR 1,234.56'),
		invoicePdf(path.join(second, 'original-invoice.pdf'), 'USD 1,500.01'), invoicePdf(path.join(first, 'restaurant-receipt.pdf'), 'EUR 142.00', true)]);
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
		await resize(1440);
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
		await expect(detail.getByRole('heading', { name: 'Orchard_Workshop_invoice.pdf', exact: true })).toBeVisible();
		await expect(detail.getByText('Receipt filename', { exact: true })).toBeVisible();
		await expect(detail.getByText('Orchard_Workshop_invoice.pdf · Bank Orchard Workshop')).toBeVisible();
		await expect.poll(async () => {
			const [transactions, evidence] = await Promise.all([list.boundingBox(), detail.boundingBox()]);
			return transactions!.x + transactions!.width < evidence!.x && transactions!.y === evidence!.y;
		}).toBe(true);
		await expect(matches.getByText('7 days apart (within 7 days)', { exact: false })).toBeVisible();
		await matches.getByRole('button', { name: /^Source evidence for / }).press('Enter');
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
		await expect(matches.getByRole('heading', { name: 'original-invoice.pdf', exact: true })).toBeVisible();
		await expect(matches.getByText('Reported original payment amount', { exact: true })).toBeVisible();
		await expect(matches.getByText('Another possible match is supported by a reference.')).toHaveCount(2);
		await test.step('review, replace and remove assignments through the interface', async () => {
			const manual = detail.getByRole('region', { name: 'Manual review' });
			const picker = manual.getByRole('combobox', { name: 'Supporting document' });
			async function choose(filename: string) {
				await picker.click();
				await page.getByRole('option', { name: new RegExp('^' + filename) }).click();
			}
			await filters.getByRole('button', { name: 'Unmatched 1' }).click();
			await choose('restaurant-receipt');
			await expect(detail.getByText(/256[.,]20/)).toBeVisible();
			await expect(manual.getByText(/Document total.*142[.,]00/)).toBeVisible();
			await manual.getByRole('button', { name: 'Assign document', exact: true }).press('Enter');
			await expect(manual.getByRole('heading', { name: 'Manual review', exact: true })).toBeFocused();
			await expect(manual.getByText('Document assigned · restaurant-receipt.pdf')).toBeVisible();
			await filters.getByRole('button', { name: 'Uncertain 1' }).click();
			await picker.click();
			await expect(page.getByRole('option', { name: /restaurant-receipt.*Assigned to.*River Studio/ })).toBeDisabled();
			await picker.press('Escape');
			const originalCandidate = detail.getByRole('article').filter({ has: page.getByRole('heading', { name: 'original-invoice.pdf', exact: true }) });
			await originalCandidate.getByRole('button', { name: /^Assign this document/ }).press('Enter');
			await expect(originalCandidate.getByText('Assigned to this transaction', { exact: true })).toBeVisible();
			await expect(originalCandidate.getByText('Uncertain', { exact: true })).toBeVisible();
			await expect(manual.getByText('Document assigned · original-invoice.pdf')).toBeVisible();
			const accountCandidate = detail.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Orchard_Workshop_invoice.pdf', exact: true }) });
			await accountCandidate.getByRole('button', { name: /^Replace with this document/ }).click();
			await expect(manual.getByText('Document assigned · Orchard_Workshop_invoice.pdf')).toBeVisible();
			await manual.getByRole('button', { name: 'Remove assignment' }).click();
			await manual.getByRole('button', { name: 'Complete without document' }).click();
			await expect(manual.getByRole('button', { name: 'Reopen transaction' })).toBeVisible();
			await manual.getByRole('button', { name: 'Reopen transaction' }).click();
			await manual.getByRole('button', { name: 'Complete without document' }).click();
			await filters.getByRole('button', { name: 'Unmatched 1' }).click();
			await choose('Orchard_Workshop_invoice');
			await manual.getByRole('button', { name: 'Replace document' }).click();
			await expect(manual.getByText('Document assigned · Orchard_Workshop_invoice.pdf')).toBeVisible();
			await manual.getByRole('button', { name: 'Remove assignment' }).click();
			await expect(manual.getByText('Open', { exact: true })).toBeVisible();
			await choose('restaurant-receipt');
			await manual.getByRole('button', { name: 'Assign document', exact: true }).click();
			await expect(matches.getByText('0 open · 1 with a document · 1 completed without a document')).toBeVisible();
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
		await expect(restored.getByRole('heading', { name: 'original-invoice.pdf', exact: true })).toBeVisible();
		await expect(restored.getByText('Matching reference', { exact: true })).toHaveCount(2);
		await expect(restored.getByRole('region', { name: 'Manual review' }).getByText('Completed without document', { exact: true })).toBeVisible();
		await restored.getByRole('group', { name: 'Filter match results' }).getByRole('button', { name: 'Unmatched 1' }).click();
		await expect(restored.getByRole('region', { name: 'Manual review' }).getByText('Document assigned · restaurant-receipt.pdf')).toBeVisible();
		const decisions = await reopened.evaluate(async () => {
			const bridge = window.receiptmatch;
			const { workspace } = await bridge.command({ type: 'get-state' });
			const rows = await bridge.matchSummaries(workspace!.matchRevision);
			return rows?.map(row => [row.status, row.review.status]).sort();
		});
		expect(decisions).toEqual([['uncertain', 'completed-without-document'], ['unmatched', 'assigned']]);
		await test.step('correct original receipt fields, recalculate suggestions and reopen with the assignment intact', async () => {
			await restoredNav.getByRole('button', { name: 'Sources' }).click();
			const documents = reopened.getByRole('region', { name: 'Supporting documents' });
			await expect(documents.getByRole('button', { name: /^documents ·/ })).toHaveAttribute('aria-expanded', 'true');
			const receipt = documents.getByRole('button', { name: 'restaurant-receipt.pdf', exact: true });
			await receipt.click();
			const analysis = documents.locator('#' + (await receipt.getAttribute('aria-controls')));
			const amountField = analysis.locator('details').filter({ has: reopened.getByText('Billed total', { exact: true }) });
			await amountField.locator('summary').first().click();
			await amountField.getByRole('button', { name: 'Correct value' }).press('Enter');
			const editor = analysis.getByRole('region', { name: 'Correct document field' });
			await expect(editor.getByRole('heading')).toBeFocused();
			const decimal = await reopened.evaluate(() => new Intl.NumberFormat().formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.');
			await editor.getByLabel('Amount', { exact: true }).fill(`256${decimal}20`);
			await expect(editor.getByLabel('Currency')).toHaveValue('EUR');
			await editor.getByRole('button', { name: 'Apply correction' }).click();
			await expect(editor.getByText('Correction applied to this workspace.')).toBeVisible();
			await expect(amountField.getByText('Original values', { exact: true })).toBeVisible();
			await expect(amountField.getByText(/142[.,]00/).first()).toBeVisible();
			await editor.getByRole('button', { name: 'Close', exact: true }).click();
			const dateField = analysis.locator('details').filter({ has: reopened.getByText('Issue date', { exact: true }) });
			await dateField.locator('summary').first().click();
			await dateField.getByRole('button', { name: 'Correct value' }).click();
			await editor.getByLabel('Date', { exact: true }).fill('2032-02-24');
			await editor.getByRole('button', { name: 'Apply correction' }).click();
			await expect(editor.getByText('Correction applied to this workspace.')).toBeVisible();
			await restoredNav.getByRole('button', { name: 'Match suggestions' }).click();
			await restored.getByRole('group', { name: 'Filter match results' }).getByRole('button', { name: 'Uncertain 2' }).click();
			await restored.getByRole('button', { name: /River Studio/ }).click();
			await expect(restored.getByRole('heading', { name: 'restaurant-receipt.pdf', exact: true })).toBeVisible();
			await expect(restored.getByText('3 days apart (within 7 days)', { exact: false })).toBeVisible();
			await expect(restored.getByText('This section contains corrected values.', { exact: false })).toBeVisible();
			await expect(restored.getByRole('region', { name: 'Manual review' }).getByText('Document assigned · restaurant-receipt.pdf')).toBeVisible();
			await reopened.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(reopened.getByText('All changes saved', { exact: true })).toBeVisible();
			await app.close();
			app = await launch('third-profile');
			const saved = await app.firstWindow();
			await dialogs(app, [workspaceFile]);
			await saved.getByRole('button', { name: 'Open workspace', exact: false }).click();
			await saved.getByRole('button', { name: 'Match suggestions', exact: true }).click();
			await saved.getByRole('button', { name: /River Studio/ }).click();
			await expect(saved.getByRole('heading', { name: 'restaurant-receipt.pdf', exact: true })).toBeVisible();
			await expect(saved.getByText('3 days apart (within 7 days)', { exact: false })).toBeVisible();
			await expect(saved.getByRole('region', { name: 'Manual review' }).getByText('Document assigned · restaurant-receipt.pdf')).toBeVisible();
		});
	} finally { await app.close(); }
});

test('keeps the assignment panel in view and previews a document without a total', async ({ playwright }, testInfo) => {
	const root = testInfo.outputPath('scroll-workspace');
	await mkdir(root, { recursive: true });
	const bank = retainedBank(root);
	const seed = bank.result.transactions[0];
	for (let index = 1; index <= 38; index++) {
		const rowId = `synthetic-purchase-${index}`;
		bank.result.transactions.push({ ...seed, rowId, references: [], description: { ...seed.description, value: `Synthetic purchase ${index}` } });
		bank.transactions.push({ rowId, transactionId: randomUUID() });
	}
	seed.description = { ...seed.description, value: 'Vela Restaurant New' };
	seed.counterpartyCandidate = null;
	seed.reportedOriginalAmount = null;
	seed.accountAmount = { ...seed.accountAmount, value: { currency: 'EUR', coefficient: '-17677', scale: 2 } };
	const receipt = extractedDocument(Buffer.from('synthetic receipt without total'), randomUUID());
	receipt.input.pages[0].spans = ['Receipt', 'Merchant: Corner Cafe', 'Receipt Number: WITHOUT-TOTAL'].map((line, index) => span(line, 30, 30 + index * 30, 250));
	const near = extractedDocument(Buffer.from('synthetic receipt with a different total'), randomUUID());
	near.input.pages[0].spans = ['Vela Backyard', 'Total: EUR 160.70'].map((line, index) => span(line, 30, 30 + index * 30, 250));
	const imports = documentRun(root, [{ id: randomUUID(), filePath: path.join(root, 'without-total.pdf'), format: 'pdf',
		importedAt: '2032-02-27T00:00:00.000Z', result: interpretSupportingDocument(receipt.input) },
	{ id: randomUUID(), filePath: path.join(root, 'Vela-Backyard.pdf'), format: 'pdf',
		importedAt: '2032-02-27T00:00:00.000Z', result: interpretSupportingDocument(near.input) }]);
	const file = path.join(root, 'scroll.receiptmatch');
	const airwallex = retainedBank(root, airwallexStatement());
	airwallex.filePath = path.join(root, 'airwallex.pdf');
	await createWorkspace(file, newMetadata(), [bank, airwallex], [imports]);
	const app = await playwright._electron.launch({
		executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
		args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, 'profile')}`],
	});
	try {
		const page = await app.firstWindow();
		await dialogs(app, [file]);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 800));
		await page.getByRole('button', { name: 'Open workspace', exact: false }).click();
		await page.getByRole('button', { name: 'Match suggestions', exact: true }).click();
		const list = page.getByRole('region', { name: 'Transactions', exact: true });
		const detail = page.locator('#match-detail-panel');
		const card = list.getByRole('button', { name: 'Card Lantern Supplies, USA, (Main Card, **0000): USD 18.07 1 EUR = 1.100000 USD', exact: true });
		await expect(card).toBeVisible();
		await expect(card).toHaveCSS('white-space', 'pre-line');
		await expect(list.getByRole('button', { name: 'Payout Pay EUR 13.07 to Silver Birch Workshop', exact: true })).toBeVisible();
		const purchase = list.getByRole('button', { name: 'Synthetic purchase 27', exact: true });
		await purchase.scrollIntoViewIfNeeded();
		const position = await page.evaluate(() => scrollY);
		expect(position).toBeGreaterThan(300);
		await purchase.press('Enter');
		await expect(detail.getByRole('heading', { name: /Synthetic purchase 27/ })).toBeFocused();
		expect(await page.evaluate(() => scrollY)).toBeCloseTo(position, 0);
		await expect.poll(() => detail.evaluate(panel => Math.round(panel.getBoundingClientRect().top))).toBe(16);
		const manual = detail.getByRole('region', { name: 'Manual review' });
		const picker = manual.getByRole('combobox', { name: 'Supporting document' });
		await picker.press('Enter');
		await page.getByRole('option', { name: 'without-total.pdf', exact: true }).click();
		await expect(manual.getByText('Document total unavailable', { exact: true })).toBeVisible();
		await manual.getByRole('button', { name: 'Document details for without-total.pdf' }).press('Enter');
		await expect(manual.getByRole('heading', { name: 'Document fields' })).toBeVisible();
		await expect(manual.getByText('Corner Cafe', { exact: false })).toBeVisible();
		await manual.locator('summary').filter({ hasText: 'Source text' }).press('Enter');
		await expect(manual.getByText('Receipt Number: WITHOUT-TOTAL', { exact: true })).toBeVisible();
		await manual.getByRole('button', { name: 'Clear supporting document selection' }).click();
		await expect(manual.getByRole('heading', { name: 'Document fields' })).toHaveCount(0);
		await page.getByRole('group', { name: 'Filter match results' }).getByRole('button', { name: 'Uncertain 1' }).click();
		await expect(list.getByRole('button', { name: 'Vela Restaurant New' })).toBeVisible();
		const candidate = detail.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Vela-Backyard.pdf', exact: true }) });
		await expect(candidate.getByText('Part of the name matches.')).toBeVisible();
		await expect(candidate.getByText('Amounts are close, with a difference to review.')).toBeVisible();
		await expect(candidate.getByRole('button', { name: /^Assign this document/ })).toBeEnabled();
	} finally { await app.close(); }
});
