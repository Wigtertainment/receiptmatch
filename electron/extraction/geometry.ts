import type { PositionedSpan } from '../../src/shared/bank-import.js';

interface ViewportGeometry {
    width: number;
    height: number;
    transform: readonly number[];
}
interface TextGeometry {
    transform: readonly number[];
    width: number;
    height: number;
}
interface FontGeometry {
    ascent?: number;
    descent?: number;
    vertical?: boolean;
}
export interface GeometryResult {
    region: PositionedSpan['region'] | null;
    clipped: boolean;
    approximate: boolean;
}

function transformed(matrix: readonly number[], x: number, y: number): [number, number] {
    return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}
function visibleBox(points: [number, number][], width: number, height: number): { region: PositionedSpan['region'] | null; clipped: boolean } {
    if (![width, height, ...points.flat()].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Invalid page geometry.');
    const left = Math.min(...points.map((point) => point[0]));
    const top = Math.min(...points.map((point) => point[1]));
    const right = Math.max(...points.map((point) => point[0]));
    const bottom = Math.max(...points.map((point) => point[1]));
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    const endX = Math.min(width, right);
    const endY = Math.min(height, bottom);
    const clipped = left < 0 || top < 0 || right > width || bottom > height;
    return { region: endX > x && endY > y ? { x, y, width: endX - x, height: endY - y } : null, clipped };
}
export function embeddedTextGeometry(item: TextGeometry, font: FontGeometry, viewport: ViewportGeometry): GeometryResult {
    if (item.transform.length !== 6 || viewport.transform.length !== 6 || ![...item.transform, ...viewport.transform, item.width, item.height].every(Number.isFinite)) {
        throw new Error('Invalid text transform.');
    }
    if (font.vertical) throw new Error('Vertical embedded text needs a supported geometry mapping.');
    const [a, b, c, d, e, f] = item.transform;
    const baseline = transformed(viewport.transform, e, f);
    const horizontal = transformed(viewport.transform, e + a, f + b);
    const vertical = transformed(viewport.transform, e + c, f + d);
    const axisX = horizontal[0] - baseline[0];
    const axisY = horizontal[1] - baseline[1];
    const normalX = vertical[0] - baseline[0];
    const normalY = vertical[1] - baseline[1];
    const axisLength = Math.hypot(axisX, axisY);
    const pageScale = Math.hypot(viewport.transform[0], viewport.transform[1]);
    if (item.width <= 0 || axisLength <= 0 || Math.hypot(normalX, normalY) <= 0) throw new Error('Degenerate text geometry.');
    const validMetrics = Number.isFinite(font.ascent) && Number.isFinite(font.descent) && font.ascent! > font.descent!;
    const ascent = validMetrics ? font.ascent! : 1;
    const descent = validMetrics ? font.descent! : 0;
    const advanceX = (axisX / axisLength) * item.width * pageScale;
    const advanceY = (axisY / axisLength) * item.width * pageScale;
    const points: [number, number][] = [ascent, descent].flatMap((metric) => [
        [baseline[0] + normalX * metric, baseline[1] + normalY * metric] as [number, number],
        [baseline[0] + normalX * metric + advanceX, baseline[1] + normalY * metric + advanceY] as [number, number]
    ]);
    return { ...visibleBox(points, viewport.width, viewport.height), approximate: !validMetrics };
}
export function ocrWordGeometry(
    bbox: { x0: number; y0: number; x1: number; y1: number },
    page: { width: number; height: number },
    canvas: { width: number; height: number }
): GeometryResult {
    if (
        ![bbox.x0, bbox.y0, bbox.x1, bbox.y1, canvas.width, canvas.height].every(Number.isFinite) ||
        canvas.width <= 0 ||
        canvas.height <= 0 ||
        bbox.x1 <= bbox.x0 ||
        bbox.y1 <= bbox.y0
    ) {
        throw new Error('Invalid OCR word geometry.');
    }
    return {
        ...visibleBox(
            [
                [(bbox.x0 / canvas.width) * page.width, (bbox.y0 / canvas.height) * page.height],
                [(bbox.x1 / canvas.width) * page.width, (bbox.y1 / canvas.height) * page.height]
            ],
            page.width,
            page.height
        ),
        approximate: false
    };
}
