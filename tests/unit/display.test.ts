import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { formatCalendarDate, formatMoney } from '../../src/shared/display.js';

test('money display uses locale separators and explicit currencies while preserving every decimal digit', () => {
    const amount = { coefficient: '-123456', currency: 'EUR', scale: 2 };
    assert.equal(formatMoney(amount, 'en-US'), '-EUR\u00a01,234.56');
    assert.equal(formatMoney(amount, 'de-DE'), '-1.234,56\u00a0EUR');
    assert.equal(formatMoney({ coefficient: '-1', currency: 'USD', scale: 2 }, 'en-US'), '-USD\u00a00.01');
    assert.equal(formatMoney({ coefficient: '900719925474099301', currency: 'EUR', scale: 2 }, 'en-US'), 'EUR\u00a09,007,199,254,740,993.01');
    assert.equal(formatMoney({ coefficient: '900719925474099301', currency: null, scale: 2 }, 'de-DE'), '9.007.199.254.740.993,01 (currency unknown)');
    assert.equal(formatMoney({ coefficient: '1000000000000000001', currency: 'USD', scale: 18 }, 'en-US'), 'USD\u00a01.000000000000000001');
    assert.equal(formatMoney({ coefficient: '42', currency: 'JPY', scale: 0 }, 'en-US'), 'JPY\u00a042');
    assert.equal(formatMoney({ coefficient: '120', currency: 'CHF', scale: 3 }, 'de-DE'), '0,120\u00a0CHF');
    assert.equal(formatMoney({ coefficient: '0', currency: 'EUR', scale: 2 }, 'en-US'), 'EUR\u00a00.00');
    const large = '12345678901234567890'.repeat(6) + '12345678';
    const rendered = formatMoney({ coefficient: large, currency: 'EUR', scale: 18 }, 'en-US');
    assert.equal(rendered.replace(/[^0-9]/g, ''), large);
    assert.equal(formatMoney(null), 'Unknown');
});

test('calendar display follows locale order without changing the printed booking day or the early calendar year', () => {
    assert.equal(formatCalendarDate('2032-02-28', 'en-US'), '02/28/2032');
    assert.equal(formatCalendarDate('2032-02-28', 'de-DE'), '28.02.2032');
    assert.equal(formatCalendarDate('2032-02-28', 'en-GB'), '28/02/2032');
    assert.equal(formatCalendarDate('2000-02-29', 'en-GB'), '29/02/2000');
    assert.equal(formatCalendarDate('0001-01-01', 'en-US'), '01/01/1');
    assert.equal(formatCalendarDate(null), 'Unknown');
});

test('calendar display keeps the same booking day in distant host time zones', () => {
    const moduleUrl = new URL('../../src/shared/display.ts', import.meta.url).href;
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
        const code = "const {formatCalendarDate,formatMoney}=await import(process.argv[1]);console.log(JSON.stringify({date:formatCalendarDate('2032-02-28','en-US'),money:formatMoney({coefficient:'900719925474099301',currency:'EUR',scale:2},'en-US')}));";
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', code, moduleUrl], { encoding: 'utf8', env: { ...process.env, TZ: zone }, timeout: 10000, windowsHide: true });
        assert.equal(run.status, 0, run.stderr);
        const value = JSON.parse(run.stdout) as { date: string; money: string };
        assert.equal(value.date, '02/28/2032');
        assert.equal(value.money, 'EUR\u00a09,007,199,254,740,993.01');
    }
});
