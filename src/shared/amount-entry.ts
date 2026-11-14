import type { ZodSafeParseResult } from 'zod';
import { moneySchema, type Money } from './money.js';

const decimal: string = new Intl.NumberFormat().formatToParts(1.1).find((part: Intl.NumberFormatPart): boolean => part.type === 'decimal')?.value ?? '.';
export const amountEntryExample: string = '12' + decimal + '34';

export function formatAmountEntry(value: Pick<Money, 'coefficient' | 'scale'> | undefined, separator: string = decimal): string {
    if (!value) {
        return '';
    }
    const negative: boolean = value.coefficient.startsWith('-');
    const digits: string = (negative ? value.coefficient.slice(1) : value.coefficient).padStart(value.scale + 1, '0');
    const magnitude: string = value.scale ? digits.slice(0, -value.scale) + separator + digits.slice(-value.scale) : digits;
    return (negative ? '-' : '') + magnitude;
}

export function parseAmountEntry(value: string, currency: string): Money | null {
    const signed: string = value.trim().replace(/^−/, '-');
    const normalized: string = decimal === '.' ? signed : signed.includes('.') ? '' : signed.replace(decimal, '.');
    const parts: RegExpExecArray | null = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
    if (!parts) {
        return null;
    }
    const fraction: string = parts[3] ?? '';
    const digits: string = (parts[2] + fraction).replace(/^0+(?=\d)/, '');
    const amount: ZodSafeParseResult<{ coefficient: string; currency: string; scale: number; }> = moneySchema.safeParse({ coefficient: parts[1] === '-' && digits !== '0' ? '-' + digits : digits, scale: fraction.length, currency });
    return amount.success ? amount.data : null;
}
