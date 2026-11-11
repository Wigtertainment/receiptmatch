import { moneySchema, type Money } from './money.js';

const decimal = new Intl.NumberFormat().formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.';
export const amountEntryExample = '12' + decimal + '34';

export function formatAmountEntry(value: Pick<Money, 'coefficient' | 'scale'> | undefined): string {
    if (!value) return '';
    const negative = value.coefficient.startsWith('-');
    const digits = (negative ? value.coefficient.slice(1) : value.coefficient).padStart(value.scale + 1, '0');
    const magnitude = value.scale ? digits.slice(0, -value.scale) + decimal + digits.slice(-value.scale) : digits;
    return (negative ? '-' : '') + magnitude;
}

export function parseAmountEntry(value: string, currency: string): Money | null {
    const signed = value.trim().replace(/^−/, '-');
    const normalized = decimal === '.' ? signed : signed.includes('.') ? '' : signed.replace(decimal, '.');
    const parts = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
    if (!parts) return null;
    const fraction = parts[3] ?? '';
    const digits = (parts[2] + fraction).replace(/^0+(?=\d)/, '');
    const amount = moneySchema.safeParse({ coefficient: parts[1] === '-' && digits !== '0' ? '-' + digits : digits, scale: fraction.length, currency });
    return amount.success ? amount.data : null;
}
