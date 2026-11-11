import { test } from 'vitest';
import assert from 'node:assert/strict';
import { embeddedTextGeometry, ocrWordGeometry } from '../../electron/extraction/geometry.js';
import { extractionResultSchema } from '../../src/shared/pdf-extraction.js';
import { statement } from './bank-fixtures.js';

function near(actual: { x: number; y: number; width: number; height: number } | null, expected: { x: number; y: number; width: number; height: number }) {
    assert.ok(actual);
    for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 0.000001, `${key}: ${actual[key]} vs ${expected[key]}`);
}
const item = { transform: [12, 0, 0, 12, 30, 60], width: 40, height: 12 };
const font = { ascent: 0.8, descent: -0.2 };

test('embedded geometry applies visible crop, all page rotations and font ascent/descent rather than height-minus-y', () => {
    for (const [transform, width, height, expected] of [
        [[1, 0, 0, -1, -10, 110], 200, 100, { x: 20, y: 40.4, width: 40, height: 12 }],
        [[0, 1, 1, 0, -10, -10], 100, 200, { x: 47.6, y: 20, width: 12, height: 40 }],
        [[-1, 0, 0, 1, 210, -10], 200, 100, { x: 140, y: 47.6, width: 40, height: 12 }],
        [[0, -1, -1, 0, 110, 210], 100, 200, { x: 40.4, y: 140, width: 12, height: 40 }],
        [[2, 0, 0, -2, -20, 220], 400, 200, { x: 40, y: 80.8, width: 80, height: 24 }]
    ] as const) {
        const result = embeddedTextGeometry(item, font, { transform, width, height });
        near(result.region, expected);
        assert.equal(result.clipped, false);
        assert.equal(result.approximate, false);
    }
    const sheared = embeddedTextGeometry({ ...item, transform: [12, 0, 3, 12, 30, 60] }, font, { width: 200, height: 100, transform: [1, 0, 0, -1, -10, 110] });
    near(sheared.region, { x: 19.4, y: 40.4, width: 43, height: 12 });
});

test('crop clipping and missing font metrics remain explicit; invalid and unsupported geometry is rejected', () => {
    const viewport = { width: 200, height: 100, transform: [1, 0, 0, -1, -10, 110] };
    const clipped = embeddedTextGeometry({ ...item, transform: [12, 0, 0, 12, 5, 60] }, font, viewport);
    near(clipped.region, { x: 0, y: 40.4, width: 35, height: 12 });
    assert.equal(clipped.clipped, true);
    assert.equal(embeddedTextGeometry({ ...item, transform: [12, 0, 0, 12, -100, 60] }, font, viewport).region, null);
    assert.equal(embeddedTextGeometry(item, {}, viewport).approximate, true);
    assert.throws(() => embeddedTextGeometry(item, { ...font, vertical: true }, viewport));
    assert.equal(embeddedTextGeometry(item, { ...font, ascent: Infinity }, viewport).approximate, true);
    assert.throws(() => embeddedTextGeometry({ ...item, width: 0 }, font, viewport));
    assert.throws(() => embeddedTextGeometry({ ...item, transform: [NaN, 0, 0, 12, 30, 60] }, font, viewport));
});

test('unusable font metrics retain text with explicitly approximate geometry while invalid transforms still fail', () => {
    const viewport = { width: 200, height: 100, transform: [1, 0, 0, -1, -10, 110] };
    for (const metrics of [{ ascent: NaN }, { descent: Infinity }, { ascent: -1, descent: 1 }, { ascent: 0.2, descent: 0.3 }]) {
        const result = embeddedTextGeometry(item, metrics, viewport);
        assert.equal(result.approximate, true);
        assert.ok(result.region && result.region.width > 0 && result.region.height > 0);
        assert.ok(result.region.x >= 0 && result.region.y >= 0);
    }
    assert.throws(() => embeddedTextGeometry({ ...item, width: -1 }, { ascent: Infinity }, viewport));
    assert.throws(() => embeddedTextGeometry({ ...item, transform: [NaN, 0, 0, 12, 30, 60] }, { ascent: Infinity }, viewport));
    assert.throws(() => embeddedTextGeometry(item, { vertical: true, ascent: Infinity }, viewport));
});

test('OCR word boxes use independent actual raster ratios including ceil dimensions and visible clipping', () => {
    const page = { width: 100.25, height: 80.25 };
    const canvas = { width: 201, height: 161 };
    const result = ocrWordGeometry({ x0: 20.1, y0: 16.1, x1: 100.5, y1: 80.5 }, page, canvas);
    near(result.region, { x: 10.025, y: 8.025, width: 40.1, height: 32.1 });
    assert.equal(result.clipped, false);
    assert.equal(ocrWordGeometry({ x0: -1, y0: 0, x1: 5, y1: 5 }, page, canvas).clipped, true);
    assert.throws(() => ocrWordGeometry({ x0: 10, y0: 0, x1: 5, y1: 5 }, page, canvas));
    assert.throws(() => ocrWordGeometry({ x0: 0, y0: 0, x1: Infinity, y1: 5 }, page, canvas));
});

test('extraction outcome schema refuses complete results with issues or failed coverage and unexplained partial results', () => {
    const input = statement();
    assert.equal(extractionResultSchema.safeParse({ status: 'complete', input }).success, true);
    assert.equal(extractionResultSchema.safeParse({ status: 'partial', input }).success, false);
    input.pages[0].status = 'failed';
    input.pages[0].spans = [];
    assert.equal(extractionResultSchema.safeParse({ status: 'complete', input }).success, false);
    assert.equal(extractionResultSchema.safeParse({ status: 'failed', issues: [] }).success, false);
});
