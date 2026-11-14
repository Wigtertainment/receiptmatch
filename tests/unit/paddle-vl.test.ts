import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parsePaddleVlSpotting } from '../../electron/extraction/paddle-vl.js';

const spottingRecord: (text: string, coordinates: number[]) => string = (text: string, coordinates: number[]): string => `${text}${coordinates.map((value: number): string => `<|LOC_${value}|>`).join('')}`;

test('maps PaddleOCR-VL quadrilaterals to page regions and preserves the text they locate', (): void => {
    const output: string = `\r\n${spottingRecord('Gesamtbetrag EUR 48,75', [100, 200, 800, 250, 750, 500, 50, 450])}\r\n` +
        `${spottingRecord('Rechnung', [0, 0, 500, 0, 500, 100, 0, 100])}\r\n\r\n`;
    assert.deepEqual(parsePaddleVlSpotting(output, 800, 1000), [
        { text: 'Gesamtbetrag EUR 48,75', x0: 40, y0: 200, x1: 640, y1: 500 },
        { text: 'Rechnung', x0: 0, y0: 0, x1: 400, y1: 100 }
    ]);
    assert.deepEqual(parsePaddleVlSpotting('\n\n', 800, 1000), []);
    const framed: string = '<|TEXT_START|>Gesamtbetrag\nEUR 48,75<|TEXT_END|><|LOC_BEGIN|>' +
        spottingRecord('', [100, 200, 800, 250, 750, 500, 50, 450]) + '<|LOC_END|>';
    assert.equal(parsePaddleVlSpotting(framed, 800, 1000)[0].text, 'Gesamtbetrag\nEUR 48,75');
    assert.equal(parsePaddleVlSpotting(output.replace(/\r?\n/g, ''), 800, 1000).length, 2);
    assert.equal(parsePaddleVlSpotting(spottingRecord('Discount < EUR 5', [0, 0, 500, 0, 500, 100, 0, 100]), 800, 1000)[0].text, 'Discount < EUR 5');
});

test('rejects PaddleOCR-VL output without complete valid geometry', (): void => {
    const good: string = spottingRecord('EUR 48,75', [100, 200, 800, 200, 800, 500, 100, 500]);
    for (const invalid of ['Unpositioned text', spottingRecord('Incomplete', [0, 0, 800, 0]),
        spottingRecord('Outside page', [0, 0, 1001, 0, 800, 500, 0, 500]), spottingRecord('Empty box', [0, 0, 100, 0, 800, 0, 0, 0])]) {
        assert.throws((): { text: string; x0: number; y0: number; x1: number; y1: number; }[] => parsePaddleVlSpotting(`${good}\n${invalid}`, 800, 1000), /PaddleOCR-VL returned/);
    }
});
