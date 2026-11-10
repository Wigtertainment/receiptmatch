import test from 'node:test';
import assert from 'node:assert/strict';
import { bankImportInputSchema, bankImportResultSchema, importIssue, type BankImportInput } from '../../src/shared/bank-import.js';
import { parseBankStatement } from '../../electron/import/registry.js';
import { airwallexAdapter } from '../../electron/import/airwallex.js';
import { revolutAdapter } from '../../electron/import/revolut.js';
import { emptyPage, span, statement } from './bank-fixtures.js';
import { airwallexHeader, airwallexRow, airwallexStatement } from './airwallex-fixtures.js';

function firstTableOnly() {
    const input = airwallexStatement();
    input.pages = [input.pages[0]];
    input.pages[0].spans = input.pages[0].spans.filter((value) => value.region.y < 240);
    return input;
}

test('Airwallex preserves source order, settlement direction, explicit originals and evidence without using Global Account identity', () => {
    const input = airwallexStatement();
    const before = structuredClone(input);
    assert.equal(bankImportInputSchema.safeParse(input).success, true);
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.adapter?.bankId, 'airwallex');
    assert.equal(result.unresolvedDrafts.length, 0);
    assert.deepEqual(result.transactions.map((row) => [row.bookingDate.value, row.accountAmount.value.coefficient, row.direction]), [
        ['2032-03-01', '-1643', 'outgoing'], ['2032-03-02', '-1307', 'outgoing'], ['2032-03-03', '419', 'incoming'], ['2032-03-04', '2753', 'incoming']
    ]);
    assert.deepEqual(result.transactions[0].reportedOriginalAmount?.value, { coefficient: '-1807', currency: 'USD', scale: 2 });
    assert.equal(result.transactions[1].reportedOriginalAmount, null);
    assert.deepEqual(result.transactions[2].reportedOriginalAmount?.value, { coefficient: '419', currency: 'EUR', scale: 2 });
    assert.equal(result.transactions[3].reportedOriginalAmount, null);
    assert.equal(result.transactions[3].references.find((reference) => reference.label === 'Ref')?.value, 'SYNTHETIC-REF');
    assert.ok(result.transactions.every((row) => row.bookingDate.basisLabel === 'Date (Central European Time)' && row.valueDate === null));
    assert.ok(result.transactions[0].description.value.includes('Lantern Supplies'));
    assert.ok(result.transactions[1].description.value.includes('Workshop'));
    assert.equal(result.accountSections.length, 1);
    assert.equal(result.accountSections[0].currency.value, 'EUR');
    assert.equal(result.accountSections[0].accountReference, null);
    assert.ok(result.transactions.every((row) => row.evidence.length && row.accountAmount.evidence.length && row.bookingDate.evidence.length));
    assert.ok(result.transactions[2].reportedOriginalAmount!.evidence.every((value) => value.pageId === 'page-2'));
    assert.equal(bankImportResultSchema.safeParse(result).success, true);
    assert.deepEqual(input, before);
});

test('reordered word spans, wrapped details and mixed OCR/text preserve the same financial interpretation', () => {
    const input = airwallexStatement();
    const expected = parseBankStatement(input);
    for (const page of input.pages) {
        page.spans = page.spans.flatMap((value) => {
            if (!/^Mar \d{2} 2032$|^\d[\d,.]* EUR$/.test(value.text)) return [value];
            const words = value.text.split(' ');
            return words.map((text, index) => ({
                ...value, text, region: { ...value.region, x: value.region.x + index * value.region.width / words.length, width: value.region.width / words.length }
            }));
        }).reverse();
    }
    input.pages[1].spans.filter((value) => value.text === '4.19' || value.text.includes('Refund')).forEach((value) => { value.method = 'local-ocr'; });
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.transactions.map((row) => [row.bookingDate.value, row.accountAmount.value, row.reportedOriginalAmount?.value]),
        expected.transactions.map((row) => [row.bookingDate.value, row.accountAmount.value, row.reportedOriginalAmount?.value]));
    assert.ok(result.transactions[2].evidence.some((value) => value.method === 'local-ocr'));
    assert.ok(result.transactions[2].evidence.some((value) => value.method === 'embedded-text'));
});

test('exact account money and explicitly reported original values are never rounded or derived from exchange rates', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(...airwallexRow({
        y: 250, debit: '90,071,992,547,409.93 EUR', details: ['Cedar Goods, USA, (Main Card, **0000):', 'USD 90071992547409.95', '1 EUR = 1.000000 USD']
    }));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions[0].accountAmount.value.coefficient, '-9007199254740993');
    assert.equal(result.transactions[0].reportedOriginalAmount?.value.coefficient, '-9007199254740995');
    const rateOnly = firstTableOnly();
    rateOnly.pages[0].spans.push(...airwallexRow({ y: 250, debit: '18.01 EUR', details: ['Cedar Goods, USA', '1 EUR = 1.100000 USD'] }));
    const noOriginal = parseBankStatement(rateOnly);
    assert.equal(noOriginal.status, 'complete');
    assert.equal(noOriginal.transactions[0].reportedOriginalAmount, null);
});

test('malformed settlement decimals, signs, currencies and grouping stay unresolved rather than using the balance', () => {
    for (const value of ['1,00.00 EUR', '1.001 EUR', '-1.00 EUR', '+1.00 EUR', '01.00 EUR', 'USD 1.00', '1e2 EUR']) {
        const input = firstTableOnly();
        input.pages[0].spans.push(...airwallexRow({ y: 250, debit: value }));
        const result = parseBankStatement(input);
        assert.equal(result.status, 'partial', value);
        assert.equal(result.transactions.length, 0, value);
        assert.equal(result.unresolvedDrafts.length, 1, value);
        assert.equal(result.unresolvedDrafts[0].accountAmount, null, value);
        assert.ok(result.unresolvedDrafts[0].issues.length, value);
    }
});

test('missing or invalid dates, missing settlement columns and conflicting credit/debit preserve independent valid rows', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(
        ...airwallexRow({ y: 240, debit: '1.23 EUR' }),
        ...airwallexRow({ y: 310, date: 'Feb 30 2032', debit: '2.34 EUR' }),
        ...airwallexRow({ y: 380, date: '', debit: '3.45 EUR' }),
        ...airwallexRow({ y: 450, date: 'Mar 04 2032' }),
        ...airwallexRow({ y: 520, date: 'Mar 05 2032', debit: '4.56 EUR', credit: '5.67 EUR' })
    );
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 1);
    assert.equal(result.unresolvedDrafts.length, 4);
    assert.equal(result.unresolvedDrafts[0].bookingDate, null);
    assert.equal(result.unresolvedDrafts[1].bookingDate, null);
    assert.equal(result.unresolvedDrafts[2].accountAmount, null);
    assert.equal(result.unresolvedDrafts[3].accountAmount, null);
    assert.equal(result.unresolvedDrafts[3].direction, null);
    assert.ok(result.unresolvedDrafts.every((row) => row.issues.length && row.evidence.length));
    assert.ok(!result.transactions[0].description.value.includes('Feb 30'));
});

test('conflicting or unreadable explicit original amounts cannot silently select a value', () => {
    for (const details of [
        ['Cedar Goods, (Main Card, **0000): USD 1.001'],
        ['Cedar Goods, (Main Card, **0000): USD 1.00', 'Other Goods, (Main Card, **0000): USD 2.00']
    ]) {
        const input = firstTableOnly();
        input.pages[0].spans.push(...airwallexRow({ y: 250, debit: '1.23 EUR', details }));
        const result = parseBankStatement(input);
        assert.equal(result.status, 'partial');
        assert.equal(result.transactions.length, 0);
        assert.equal(result.unresolvedDrafts.length, 1);
        assert.ok(result.unresolvedDrafts[0].issues.some((issue) => issue.field === 'reportedOriginalAmount'));
    }
});

test('empty reference labels do not consume later Global Account details or invent a payment reference', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(...airwallexRow({
        y: 250, kind: 'Deposit', credit: '8.04 EUR', details: ['Willow Guild | Ref: | GA', 'XX00 SYNTHETIC ONLY | SYNTHETIC-TRANSFER-ID']
    }));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions[0].references.some((reference) => reference.label === 'Ref'), false);
    assert.equal(result.accountSections[0].accountReference, null);
});

test('headerless transaction pages and failed source pages retain visible coverage gaps', () => {
    const input = airwallexStatement();
    input.pages[1].spans = input.pages[1].spans.filter((value) => value.region.y !== 160);
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 2);
    assert.ok(result.unresolvedDrafts.length >= 2);
    assert.ok(result.issues.some((issue) => issue.pageId === 'page-2'));
    const failedInput = airwallexStatement();
    failedInput.pages[1].status = 'failed';
    failedInput.pages[1].spans = [];
    const failed = parseBankStatement(failedInput);
    assert.equal(failed.status, 'partial');
    assert.equal(failed.transactions.length, 2);
    assert.ok(failed.issues.some((issue) => issue.pageId === 'page-2'));
    assert.equal(bankImportResultSchema.safeParse(failed).success, true);
});

test('unknown pages and transaction-looking content on information pages never disappear', () => {
    const input = airwallexStatement();
    const extra = emptyPage(4);
    extra.spans = [span('Unknown source page', 40, 100, 150)];
    input.pages.push(extra);
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 4);
    assert.ok(result.issues.some((issue) => issue.pageId === 'page-4'));
    const informationRow = airwallexStatement();
    informationRow.pages[2].spans.push(...airwallexRow({ y: 350, date: 'Mar 05 2032', debit: '9.10 EUR' }));
    const suspicious = parseBankStatement(informationRow);
    assert.equal(suspicious.status, 'partial');
    assert.equal(suspicious.transactions.length, 4);
    assert.ok(suspicious.unresolvedDrafts.some((row) => row.evidence.some((value) => value.pageId === 'page-3')));
});

test('summary balances stay outside transaction data, but later transaction-looking rows remain visible', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(span('Ending balance', 110, 250, 100), span('996.93 EUR', 490, 250, 80));
    const empty = parseBankStatement(input);
    assert.equal(empty.status, 'complete');
    assert.deepEqual(empty.transactions, []);
    assert.deepEqual(empty.unresolvedDrafts, []);
    input.pages[0].spans.push(...airwallexRow({ y: 300, debit: '1.23 EUR' }));
    const suspicious = parseBankStatement(input);
    assert.equal(suspicious.status, 'partial');
    assert.equal(suspicious.transactions.length, 0);
    assert.ok(suspicious.unresolvedDrafts.length);
});

test('missing transaction type does not cause a damaged row to merge with a neighboring transaction', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(
        ...airwallexRow({ y: 250, debit: '1.23 EUR' }),
        ...airwallexRow({ y: 320, kind: '', date: 'Mar 02 2032', debit: '2.34 EUR', details: ['Unlabeled damaged row'] })
    );
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 1);
    assert.equal(result.unresolvedDrafts.length, 1);
    assert.ok(!result.transactions[0].description.value.includes('Unlabeled damaged row'));
});

test('adapter recognition rejects other banks, layouts and non-EUR activity without modifying the Revolut route', () => {
    assert.equal(revolutAdapter.identify(airwallexStatement()), false);
    assert.equal(airwallexAdapter.identify(statement()), false);
    assert.equal(parseBankStatement(statement()).adapter?.bankId, 'revolut');
    const unknown = airwallexStatement();
    unknown.pages = [unknown.pages[0]];
    unknown.pages[0].spans = unknown.pages[0].spans.filter((value) => !value.text.includes('airwallex'));
    assert.equal(parseBankStatement(unknown).status, 'unsupported');
    const missingColumns = airwallexStatement();
    for (const page of missingColumns.pages) page.spans = page.spans.filter((value) => value.text !== 'Debit');
    assert.equal(parseBankStatement(missingColumns).status, 'unsupported');
    for (const currency of ['USD', 'GBP']) {
        const input = airwallexStatement();
        for (const page of input.pages) for (const value of page.spans) value.text = value.text.replace(/\bEUR\b/g, currency);
        assert.equal(parseBankStatement(input).status, 'unsupported');
    }
    const conflictingCurrency = airwallexStatement();
    conflictingCurrency.pages[1].spans.find((value) => value.text.startsWith('EUR Account Activity'))!.text = 'USD Account Activity (Continued)';
    assert.equal(parseBankStatement(conflictingCurrency).status, 'unsupported');
});

test('registry refuses a document identifying as both banks rather than preferring registration order', () => {
    const input = airwallexStatement();
    const other = statement().pages[0];
    other.pageNumber = 4;
    other.pageId = 'page-4';
    input.pages.push(other);
    const result = parseBankStatement(input);
    assert.equal(result.status, 'unsupported');
    assert.ok(result.issues.some((issue) => issue.code === 'ambiguous-adapter'));
    assert.deepEqual(result.transactions, []);
});

test('extraction warnings stay visible and invalid transport input fails before parsing', () => {
    const input = airwallexStatement();
    input.issues.push({ ...importIssue('synthetic-warning', 'Synthetic uncertain extraction.'), severity: 'warning', pageId: 'page-1' });
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 4);
    assert.ok(result.issues.some((issue) => issue.code === 'synthetic-warning'));
    const invalid: BankImportInput = airwallexStatement();
    invalid.pages[0].spans[0].region.width = 900;
    assert.equal(parseBankStatement(invalid).status, 'failed');
    assert.equal(bankImportResultSchema.safeParse(parseBankStatement(invalid)).success, true);
});

test('without a printed timezone note the booking date keeps the source Date label', () => {
    const input = airwallexStatement();
    input.pages[2].spans = input.pages[2].spans.filter((value) => !value.text.includes('generated using Central European Time'));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.ok(result.transactions.every((row) => row.bookingDate.basisLabel === 'Date'));
});

test('missing source pages and inconsistent printed page counts cannot report complete coverage', () => {
    for (const missingPage of [2, 3]) {
        const input = airwallexStatement();
        input.pages = input.pages.filter((page) => page.pageNumber !== missingPage);
        const result = parseBankStatement(input);
        assert.equal(result.status, 'partial');
        assert.equal(result.transactions.length, missingPage === 2 ? 2 : 4);
        assert.ok(result.issues.some((issue) => issue.code === 'incomplete-page-coverage'));
        assert.equal(bankImportResultSchema.safeParse(result).success, true);
    }
    const inconsistent = airwallexStatement();
    inconsistent.pages[1].spans.find((value) => value.text === 'Page 2 of 3')!.text = 'Page 2 of 4';
    const result = parseBankStatement(inconsistent);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 4);
    assert.ok(result.issues.some((issue) => issue.code === 'incomplete-page-coverage'));
});

test('repeated transaction headers within one page do not become rows or merge neighboring blocks', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(...airwallexRow({ y: 250, debit: '1.23 EUR' }), ...airwallexHeader(350), ...airwallexRow({ y: 380, date: 'Mar 02 2032', debit: '2.34 EUR' }));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions.length, 2);
    assert.deepEqual(result.transactions.map((row) => row.accountAmount.value.coefficient), ['-123', '-234']);
});

test('transactions before a later intact header remain unresolved when the earlier header is damaged', () => {
    const input = firstTableOnly();
    input.pages[0].spans = input.pages[0].spans.filter((value) => value.region.y !== 200 && value.region.y !== 218);
    input.pages[0].spans.push(
        ...airwallexHeader().filter((value) => value.text !== 'Debit'),
        ...airwallexRow({ y: 250, debit: '1.23 EUR' }),
        ...airwallexHeader(350),
        ...airwallexRow({ y: 380, date: 'Mar 02 2032', debit: '2.34 EUR' })
    );
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0].accountAmount.value.coefficient, '-234');
    assert.equal(result.unresolvedDrafts.length, 1);
    assert.equal(result.unresolvedDrafts[0].accountAmount, null);
    assert.ok(result.unresolvedDrafts[0].issues.some((issue) => issue.code === 'missing-table-header'));
    assert.ok(result.unresolvedDrafts[0].evidence.some((value) => value.rawText.includes('1.23 EUR')));
});

test('merchant descriptions resembling summaries and page footers are retained as transaction details', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(...airwallexRow({ y: 250, debit: '1.23 EUR', details: ['Ending balance Supplies, USA,', 'Page 1 of 9', '(Main Card, **0000): USD 2.34'] }));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions.length, 1);
    assert.match(result.transactions[0].description.value, /Ending balance Supplies/);
    assert.match(result.transactions[0].description.value, /Page 1 of 9/);
});

test('unlabeled adjacent financial anchors quarantine ambiguous intervening descriptions', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(...airwallexRow({ y: 250, debit: '1.23 EUR' }));
    input.pages[0].spans.push(span('Unknown adjacent details', 110, 286, 180), span('Mar 02 2032', 40, 298, 65), span('2.34 EUR', 400, 298, 75));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 0);
    assert.equal(result.unresolvedDrafts.length, 2);
    assert.ok(result.issues.some((issue) => issue.code === 'ambiguous-row-boundary'));
    assert.ok(result.unresolvedDrafts.some((row) => row.evidence.some((value) => value.rawText.includes('Unknown adjacent details'))));
});

test('the complete original amount suffix is validated rather than selecting a numeric prefix', () => {
    for (const tail of ['USD 1.23 4.56', 'USD 1.23 invalid text', 'USD 1.23 USD 4.56']) {
        const input = firstTableOnly();
        input.pages[0].spans.push(...airwallexRow({ y: 250, debit: '1.00 EUR', details: ['Cedar Goods, USA,', `(Main Card, **0000): ${tail}`] }));
        const result = parseBankStatement(input);
        assert.equal(result.status, 'partial');
        assert.equal(result.transactions.length, 0);
        assert.equal(result.unresolvedDrafts[0].reportedOriginalAmount, null);
        assert.ok(result.issues.some((issue) => issue.code === 'invalid-original-amount'));
    }
});

test('a transaction description cannot supply the date basis for the whole statement', () => {
    const input = firstTableOnly();
    input.pages[0].spans.push(...airwallexRow({ y: 250, debit: '1.00 EUR', details: [
        'Balances and account activities in this report were generated using Central European Time.'
    ] }));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions[0].bookingDate.basisLabel, 'Date');
});

test('result overflow fails visibly and retains a valid failure contract', () => {
    const input = airwallexStatement();
    input.issues = Array.from({ length: 1000 }, () => importIssue('source-warning', 'Synthetic extraction uncertainty.'));
    input.pages[1].status = 'failed';
    input.pages[1].spans = [];
    const result = parseBankStatement(input);
    assert.equal(result.status, 'failed');
    assert.equal(result.transactions.length, 0);
    assert.ok(result.issues.some((issue) => issue.code === 'issue-limit'));
    assert.equal(bankImportResultSchema.safeParse(result).success, true);
});
