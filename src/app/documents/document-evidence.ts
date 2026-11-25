import type { PositionedSpan, SourceEvidence } from '../../shared/bank-import.js';

const numberFormat: Intl.NumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const extractionLabels: Record<SourceEvidence['method'], string> = { 'embedded-text': 'Embedded text', 'local-ocr': 'Local OCR' };
export function regionText({ x, y, width, height }: PositionedSpan['region']): string {
    const format: (value: number) => string = (value: number): string => numberFormat.format(value);
    return `x ${format(x)}, y ${format(y)}, width ${format(width)}, height ${format(height)}`;
}
