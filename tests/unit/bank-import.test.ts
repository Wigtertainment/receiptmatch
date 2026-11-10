import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BANK_IMPORT_LIMITS,
    bankImportInputSchema,
    bankImportResultSchema,
    calendarDateSchema,
    importIssue,
    type BankAdapter,
    type BankImportInput
} from '../../src/shared/bank-import.js';
import { moneySchema } from '../../src/shared/money.js';
import { moneySchema as storedMoneySchema } from '../../electron/store.js';
import { parseBankStatement } from '../../electron/import/registry.js';
import { revolutAdapter } from '../../electron/import/revolut.js';
import { emptyPage, header, row, span, statement } from './bank-fixtures.js';

test('Revolut separates settlement from balance, keeps source order, labels and exact explicit original amount', () => {
    const input = statement();
    const before = structuredClone(input);
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions.length, 2);
    assert.equal(result.unresolvedDrafts.length, 0);
    assert.deepEqual(
        result.transactions.map((row) => [row.rowId, row.bookingDate.value, row.accountAmount.value.coefficient, row.direction]),
        [
            ['p1-r1', '2032-02-28', '-123456', 'outgoing'],
            ['p1-r2', '2032-02-27', '2507', 'incoming']
        ]
    );
    const first = result.transactions[0];
    assert.deepEqual(first.accountAmount.value, { coefficient: '-123456', currency: 'EUR', scale: 2 });
    assert.deepEqual(first.reportedOriginalAmount?.value, { coefficient: '-150001', currency: 'USD', scale: 2 });
    assert.equal(first.valueDate, null);
    assert.equal(first.bookingDate.basisLabel, 'Date (UTC)');
    assert.equal(first.counterpartyCandidate?.value, 'Orchard Workshop');
    assert.equal(first.references[0].value, 'SYNTHETIC-A');
    assert.match(result.transactions[1].description.value, /\nContinued payment description/);
    assert.equal(result.adapter?.layoutVersion, '1');
    assert.equal(result.sourceProvenance?.extractionRunId, 'synthetic-run');
    assert.ok(first.accountAmount.evidence.every((value) => value.pageId === 'page-1' && value.rawText === '1,234.56'));
    assert.deepEqual(input, before);
    assert.equal(bankImportResultSchema.safeParse(result).success, true);
    assert.equal('confidence' in first, false);
    assert.equal('approved' in first, false);
});

test('positioned token/phrase spans, reordered items, repeated headers and hybrid extraction retain the same interpretation', () => {
    const input = statement();
    const second = emptyPage();
    second.spans = [...header(50, true), ...row(80, '26 Feb 2032', 'Card refund from Merchant Elm', null, '4.20', true)];
    second.spans.find((value) => value.text === '4.20')!.method = 'local-ocr';
    input.pages.push(second);
    for (const page of input.pages) page.spans.reverse();
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions.length, 3);
    assert.deepEqual(
        result.transactions.map((row) => row.rowId),
        ['p1-r1', 'p1-r2', 'p2-r1']
    );
    const third = result.transactions[2];
    assert.equal(third.bookingDate.value, '2032-02-26');
    assert.equal(third.direction, 'incoming');
    assert.equal(third.accountAmount.evidence[0].method, 'local-ocr');
    assert.equal(third.counterpartyCandidate, null);
    assert.deepEqual(third.references, []);
    assert.equal(
        third.evidence.some((value) => value.method === 'embedded-text'),
        true
    );
});

test('an explicitly identified empty table is complete; summaries, type legends and legal footers never become transactions', () => {
    const input = statement();
    input.pages[0].spans = input.pages[0].spans.filter((value) => value.region.y < 220 || value.region.y > 780);
    input.pages[0].spans.push(span('Transaction types', 40, 350, 150), span('CAR Card payment', 40, 380, 150), span('Money out 5.00', 350, 380, 100));
    const legend = emptyPage();
    legend.spans = [
        span('Money sent', 40, 40),
        span('Money received', 170, 40, 120),
        span('Card payments', 350, 40, 100),
        span('€1.00', 40, 60),
        span('€2.00', 170, 60),
        span('€3.00', 350, 60),
        span('€4.00', 435, 60)
    ];
    input.pages.push(legend);
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.transactions, []);
    assert.deepEqual(result.unresolvedDrafts, []);
});

test('partial rows keep independently valid rows; missing/conflicting columns and malformed dates stay visible', () => {
    const input = statement();
    input.pages[0].spans.push(...row(330, '31 Feb 2032', 'Invalid calendar date', '1.00', null));
    input.pages[0].spans.push(...row(360, '25 Feb 2032', 'Missing amount', null, null));
    input.pages[0].spans.push(...row(390, '24 Feb 2032', 'Conflicting debit credit', '2.00', '3.00'));
    input.pages[0].spans.push(...row(420, '?? Feb 2032', 'Unreadable printed date', '4.00', null));
    input.pages[0].spans.push(...row(450, '', 'Missing date', '5.00', null).filter((value) => value.text));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 2);
    assert.equal(result.unresolvedDrafts.length, 5);
    assert.deepEqual(
        result.unresolvedDrafts.map((row) => row.rowId),
        ['p1-r3', 'p1-r4', 'p1-r5', 'p1-r6', 'p1-r7']
    );
    assert.ok(result.unresolvedDrafts.every((row) => row.issues.length && row.evidence.length));
    assert.equal(result.unresolvedDrafts[0].bookingDate, null);
    assert.equal(result.unresolvedDrafts[2].accountAmount, null);
    assert.equal(result.unresolvedDrafts[2].direction, null);
    assert.ok(result.issues.some((issue) => issue.code === 'conflicting-fields'));
});

test('decimal parsing is exact beyond JS-safe integers and rejects source rounding, wrong currencies, signs and malformed grouping', () => {
    for (const [raw, expected] of [
        ['90,071,992,547,409.93', '-9007199254740993'],
        ['1 234.56', '-123456'],
        ['1\u00a0234.56', '-123456'],
        ['1\u202f234.56', '-123456'],
        ['0.00', '0'],
        ['EUR 10.01', '-1001'],
        ['€10.01', '-1001']
    ]) {
        const input = statement();
        input.pages[0].spans = input.pages[0].spans.filter((value) => value.region.y < 220 || value.region.y > 780);
        input.pages[0].spans.push(...row(240, '29 Feb 2032', 'Exact amount fixture', raw, null));
        const result = parseBankStatement(input);
        assert.equal(result.status, 'complete', raw);
        assert.equal(result.transactions[0].accountAmount.value.coefficient, expected);
    }
    for (const raw of ['1.001', '1,00.00', '01.00', '-1.00', '+1.00', '1e2', 'NaN', '1 23.56', '1,234 567.89', 'USD 1.00', '1,23', '9'.repeat(127) + '.00']) {
        const input = statement();
        input.pages[0].spans.find((value) => value.text === '1,234.56')!.text = raw;
        const result = parseBankStatement(input);
        assert.equal(result.status, 'partial', raw);
        assert.equal(result.transactions.length, 1, raw);
        assert.equal(result.unresolvedDrafts.length, 1, raw);
    }
});

test('extraction issues/failed pages are partial, all failed pages fail, and unknown pages do not disappear', () => {
    const input = statement();
    const failed = emptyPage();
    failed.status = 'failed';
    input.pages.push(failed);
    input.issues.push({ ...importIssue('ocr-warning', 'Synthetic extraction uncertainty.'), severity: 'warning', pageId: 'page-1' });
    let result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.equal(result.transactions.length, 2);
    assert.ok(result.issues.some((issue) => issue.code === 'failed-page'));
    assert.ok(result.issues.some((issue) => issue.code === 'ocr-warning'));
    result = parseBankStatement({ ...input, pages: [failed], issues: [] });
    assert.equal(result.status, 'failed');
    const extra = emptyPage();
    extra.spans = [span('Unclassified source material', 40, 50, 170)];
    input.pages[1] = extra;
    result = parseBankStatement(input);
    assert.equal(result.status, 'partial');
    assert.ok(result.issues.some((issue) => issue.code === 'unclassified-page'));
});

test('unknown banks, unsupported layouts/currencies and conflicting account sections cannot masquerade as complete', () => {
    const unknown = statement();
    unknown.pages[0].spans.find((value) => value.text.startsWith('Revolut'))!.text = 'Unknown bank footer';
    assert.equal(parseBankStatement(unknown).status, 'unsupported');
    const unsupported = statement();
    unsupported.pages[0].spans = unsupported.pages[0].spans.filter((value) => !value.text.startsWith('Money'));
    assert.equal(parseBankStatement(unsupported).issues[0].code, 'unsupported-bank');
    assert.equal(revolutAdapter.parse(unsupported).issues[0].code, 'unsupported-layout');
    assert.equal(revolutAdapter.identify(unsupported), false);
    const otherLayout = statement();
    otherLayout.pages[0].spans.find((value) => value.text === 'Money out')!.text = 'Debit';
    otherLayout.pages[0].spans.find((value) => value.text === 'Money in')!.text = 'Credit';
    assert.equal(revolutAdapter.identify(otherLayout), false);
    for (const currency of ['USD', 'GBP', '']) {
        const input = statement();
        input.pages[0].spans.find((value) => value.text === 'Currency EUR')!.text = `Currency ${currency}`;
        const result = parseBankStatement(input);
        assert.equal(result.status, 'unsupported');
        assert.equal(result.issues[0].code, 'unsupported-currency');
    }
    const conflicting = statement();
    conflicting.pages[0].spans.push(span('IBAN: XX00 ANOTHER SYNTHETIC', 350, 135, 200));
    assert.equal(parseBankStatement(conflicting).issues[0].code, 'unsupported-account-sections');
});

test('strict bounded input rejects unsafe geometry, duplicates, unknown keys and oversized data without truncation', () => {
    const mutations: ((input: BankImportInput) => void)[] = [
        (input) => {
            input.pages[0].spans[0].region.x = -1;
        },
        (input) => {
            input.pages[0].spans[0].region.width = Infinity;
        },
        (input) => {
            input.pages[0].spans[0].region.y = NaN;
        },
        (input) => {
            input.pages[0].spans[0].region.x = 590;
        },
        (input) => {
            input.pages.push(structuredClone(input.pages[0]));
        },
        (input) => {
            input.pages[0].spans[0].text = 'x'.repeat(BANK_IMPORT_LIMITS.spanText + 1);
        },
        (input) => {
            input.pages[0].spans = Array.from({ length: BANK_IMPORT_LIMITS.spansPerPage + 1 }, () => span('x', 1, 1));
        },
        (input) => {
            input.source.sha256 = 'invalid';
        },
        (input) => {
            input.pages[0].status = 'failed';
        },
        (input) => {
            input.issues = [{ ...importIssue('bad-page', 'Synthetic issue.'), pageId: 'not-a-source-page' }];
        },
        (input) => {
            input.issues = [{ ...importIssue('bad-row', 'Synthetic issue.'), rowId: 'not-yet-a-parser-row' }];
        }
    ];
    for (const mutate of mutations) {
        const input = statement();
        mutate(input);
        assert.equal(bankImportInputSchema.safeParse(input).success, false);
        assert.equal(parseBankStatement(input).status, 'failed');
    }
    assert.equal(parseBankStatement({ ...statement(), arbitraryPath: '/not-authorized' }).status, 'failed');
    assert.equal(parseBankStatement(null).status, 'failed');
    const unordered = statement();
    unordered.pages.push({ ...emptyPage(), pageNumber: 1 });
    assert.equal(parseBankStatement(unordered).status, 'failed');
});

test('shared money schema is unchanged and output validation checks calendar dates, signs, row links and source evidence', () => {
    assert.equal(moneySchema, storedMoneySchema);
    for (const value of ['2032-02-29', '2031-01-31', '0001-01-01']) assert.equal(calendarDateSchema.safeParse(value).success, true);
    for (const value of ['2031-02-29', '2032-04-31', '2032-13-01', '0000-01-01', '2032-02-29T00:00:00Z']) assert.equal(calendarDateSchema.safeParse(value).success, false);
    for (const coefficient of ['01', '-0', '+1', '1.0', '1e2', '1'.repeat(129)]) assert.equal(moneySchema.safeParse({ coefficient, currency: 'EUR', scale: 2 }).success, false);
    const valid = parseBankStatement(statement());
    for (const mutate of [
        (result: typeof valid) => {
            result.transactions[0].direction = 'incoming';
        },
        (result: typeof valid) => {
            result.transactions[0].rowId = result.transactions[1].rowId;
        },
        (result: typeof valid) => {
            result.transactions[0].accountSectionId = 'missing';
        },
        (result: typeof valid) => {
            result.transactions[0].bookingDate.evidence[0].pageId = 'missing';
        },
        (result: typeof valid) => {
            result.transactions[0].accountAmount.value.currency = 'USD';
        },
        (result: typeof valid) => {
            result.transactions[0].accountAmount.value.coefficient = 'invalid';
        },
        (result: typeof valid) => {
            result.transactions[0].reportedOriginalAmount!.value.coefficient = 'NaN';
        },
        (result: typeof valid) => {
            result.transactions[0].accountAmount.evidence[0].region.width = 900;
        }
    ]) {
        const result = structuredClone(valid);
        mutate(result);
        assert.equal(bankImportResultSchema.safeParse(result).success, false);
    }
});

test('registry considers every adapter, refuses ambiguous matches, validates results and contains adapter failure', () => {
    let called = false;
    const other: BankAdapter = {
        metadata: { bankId: 'synthetic-bank', adapterId: 'synthetic-adapter', version: '1', layouts: [{ layoutId: 'fixture', version: '1' }] },
        identify: () => true,
        parse: () => {
            called = true;
            throw new Error('Must not select an ambiguous adapter.');
        }
    };
    const result = parseBankStatement(statement(), [revolutAdapter, other]);
    assert.equal(result.issues[0].code, 'ambiguous-adapter');
    assert.equal(called, false);
    assert.equal(parseBankStatement(statement(), [other]).issues[0].code, 'adapter-failed');
    const badResult: BankAdapter = {
        ...other,
        parse: (input) => ({ ...revolutAdapter.parse(input), status: 'complete', transactions: [], issues: [importIssue('invalid', 'Should not be complete.')] })
    };
    assert.equal(parseBankStatement(statement(), [badResult]).issues[0].code, 'invalid-adapter-result');
    const wrongSource: BankAdapter = {
        ...revolutAdapter,
        parse: (input) => {
            const result = revolutAdapter.parse(input);
            result.sourceProvenance!.sourceId = 'different';
            return result;
        }
    };
    assert.equal(parseBankStatement(statement(), [wrongSource]).issues[0].code, 'invalid-adapter-provenance');
    const wrongPages: BankAdapter = {
        ...revolutAdapter,
        parse: (input) => {
            const result = revolutAdapter.parse(input);
            result.sourceProvenance!.pages[0].width = 900;
            return result;
        }
    };
    assert.equal(parseBankStatement(statement(), [wrongPages]).issues[0].code, 'invalid-adapter-provenance');
    assert.equal(parseBankStatement(statement(), [revolutAdapter, revolutAdapter]).status, 'failed');
});

test('failure outcomes remain valid at the extraction issue bound and explain overflow rather than silently truncating', () => {
    const input = statement();
    input.issues = Array.from({ length: 1000 }, () => importIssue('source-warning', 'Synthetic issue.'));
    input.pages[0].spans = input.pages[0].spans.filter((value) => !value.text.startsWith('Money'));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'failed');
    assert.ok(result.issues.some((issue) => issue.code === 'issue-limit'));
    assert.equal(bankImportResultSchema.safeParse(result).success, true);
    const badInput = statement();
    badInput.issues = [{ ...importIssue('invalid-row', 'Synthetic issue.'), rowId: 'p1-r1' }];
    const rejected = parseBankStatement(badInput);
    assert.equal(rejected.status, 'failed');
    assert.equal(bankImportResultSchema.safeParse(rejected).success, true);
});

test('two-column metadata is scoped to the printed label and rows remain visible at the bottom or without a continuation header', () => {
    const input = statement();
    input.pages[0].spans.push(span('Example address on the left', 40, 95, 160), span('Another header value', 40, 115, 140));
    input.pages[0].spans.push(...row(765, '23 Feb 2032', 'Near bottom transaction', '1.00', null));
    const result = parseBankStatement(input);
    assert.equal(result.status, 'complete');
    assert.equal(result.transactions.length, 3);
    assert.equal(result.accountSections[0].currency.evidence[0].rawText, 'Currency EUR');
    assert.equal(result.accountSections[0].accountReference?.value, 'XX00 SYNTHETIC ONLY');
    const noHeader = emptyPage();
    noHeader.spans = row(80, '22 Feb 2032', 'Possible row without header', '2.00', null);
    input.pages.push(noHeader);
    const partial = parseBankStatement(input);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.transactions.length, 3);
    assert.equal(partial.unresolvedDrafts.length, 1);
    assert.equal(partial.unresolvedDrafts[0].issues[0].code, 'missing-table-header');
    assert.equal(partial.unresolvedDrafts[0].accountAmount, null);
});

test('damaged balance-anchored rows and transaction-looking content after table/legend boundaries cannot silently disappear', () => {
    const damaged = statement();
    damaged.pages[0].spans.push(...row(340, '', 'Missing both date and money', null, null).filter((value) => value.text));
    const damagedResult = parseBankStatement(damaged);
    assert.equal(damagedResult.status, 'partial');
    assert.equal(damagedResult.transactions.length, 2);
    assert.equal(damagedResult.unresolvedDrafts.length, 1);
    assert.equal(damagedResult.unresolvedDrafts[0].accountAmount, null);
    assert.equal(damagedResult.unresolvedDrafts[0].bookingDate, null);
    assert.equal(damagedResult.transactions[1].description.value.includes('Missing both'), false);
    const afterSummary = statement();
    afterSummary.pages[0].spans.push(span('Closing balance', 40, 330, 100), ...row(360, '23 Feb 2032', 'Unexpected later row', '6.00', null));
    const summaryResult = parseBankStatement(afterSummary);
    assert.equal(summaryResult.status, 'partial');
    assert.equal(summaryResult.transactions.length, 2);
    assert.equal(summaryResult.unresolvedDrafts[0].issues[0].code, 'outside-table-row');
    const afterLegend = statement();
    afterLegend.pages[0].spans.push(span('Transaction types', 40, 330, 100));
    const legend = emptyPage();
    legend.spans = [
        span('Money sent', 40, 40),
        span('Money received', 170, 40, 120),
        span('Card payments', 350, 40, 100),
        ...row(80, '23 Feb 2032', 'Unexpected legend row', '6.00', null)
    ];
    afterLegend.pages.push(legend);
    const legendResult = parseBankStatement(afterLegend);
    assert.equal(legendResult.status, 'partial');
    assert.equal(legendResult.transactions.length, 2);
    assert.equal(legendResult.unresolvedDrafts.length, 1);
    const footerLike = statement();
    footerLike.pages[0].spans = footerLike.pages[0].spans.filter((value) => !value.text.startsWith('Revolut'));
    footerLike.pages[0].spans.push(span('Revolut Bank footer', 40, 60, 150), ...row(765, '', 'Revolut Bank transfer', '3.00', null).filter((value) => value.text));
    const footerLikeResult = parseBankStatement(footerLike);
    assert.equal(footerLikeResult.status, 'partial');
    assert.equal(footerLikeResult.transactions.length, 2);
    assert.equal(footerLikeResult.unresolvedDrafts.length, 1);
    assert.equal(footerLikeResult.unresolvedDrafts[0].accountAmount?.value.coefficient, '-300');
});

test('financial columns retain missing-date rows after a closing marker and on a headerless legend page', () => {
    for (const outgoing of ['8.00', null]) {
        const afterClosing = statement();
        afterClosing.pages[0].spans.push(span('Closing balance', 40, 330, 100), ...row(360, '', 'Missing date behind closing', outgoing, null).filter((value) => value.text));
        const closingResult = parseBankStatement(afterClosing);
        assert.equal(closingResult.status, 'partial');
        assert.equal(closingResult.transactions.length, 2);
        assert.equal(closingResult.unresolvedDrafts.length, 1);
        assert.equal(closingResult.unresolvedDrafts[0].issues[0].code, 'outside-table-row');
        assert.equal(closingResult.unresolvedDrafts[0].accountAmount, null);
        assert.ok(closingResult.unresolvedDrafts[0].evidence.some((value) => value.rawText.includes('Missing date behind closing')));
        const afterLegend = statement();
        afterLegend.pages[0].spans.push(span('Transaction types', 40, 330, 100));
        const legend = emptyPage();
        legend.spans = [
            span('Money sent', 40, 40),
            span('Money received', 170, 40, 120),
            span('Card payments', 350, 40, 100),
            ...row(80, '', 'Unheaded missing date', outgoing, null).filter((value) => value.text)
        ];
        afterLegend.pages.push(legend);
        const legendResult = parseBankStatement(afterLegend);
        assert.equal(legendResult.status, 'partial');
        assert.equal(legendResult.transactions.length, 2);
        assert.equal(legendResult.unresolvedDrafts.length, 1);
        assert.equal(legendResult.unresolvedDrafts[0].issues[0].code, 'missing-table-header');
        assert.equal(legendResult.unresolvedDrafts[0].accountAmount, null);
        assert.ok(legendResult.unresolvedDrafts[0].evidence.some((value) => value.rawText.includes('Unheaded missing date')));
    }
});
