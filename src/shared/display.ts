import type { Money } from './money.js';
import type { SupportingDocument } from './supporting-document.js';

// Inputs are canonical values already validated by the import/workspace schemas.
export function formatMoney(value: (Omit<Money, 'currency'> & { currency: string | null }) | null, locale?: string | string[]): string {
    if (value === null) return 'Unknown';
    const negative = value.coefficient.startsWith('-');
    const digits = (negative ? value.coefficient.slice(1) : value.coefficient).padStart(value.scale + 1, '0');
    const magnitude = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
    // Intl accepts a decimal string without converting it to an imprecise Number.
    const decimal = `${negative ? '-' : ''}${magnitude}` as Intl.StringNumericLiteral;
    const precision = { minimumFractionDigits: value.scale, maximumFractionDigits: value.scale };
    if (value.currency === null) return new Intl.NumberFormat(locale, precision).format(decimal) + ' (currency unknown)';
    return new Intl.NumberFormat(locale, { ...precision, style: 'currency', currency: value.currency, currencyDisplay: 'code' }).format(decimal);
}

export function formatCalendarDate(value: string | null, locale?: string | string[]): string {
    if (value === null) return 'Unknown';
    // A booking day has no local time zone, including in years 0001–0099.
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`));
}

export function formatDocumentTotal({ sections, issues }: SupportingDocument): string | null {
    if (sections.length !== 1) return null;
    const totals = sections[0].amounts.filter(field => field.role === 'billed-total');
    const total = totals[0];
    if (totals.length !== 1 || total.candidates.length !== 1 || !total.candidates[0].currency || issues.some(issue => issue.fieldId === total.id)) return null;
    return formatMoney(total.candidates[0]);
}
