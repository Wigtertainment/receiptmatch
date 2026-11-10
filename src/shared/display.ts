import type { Money } from './money.js';

// Inputs are canonical values already validated by the import/workspace schemas.
export function formatMoney(value: Money | null, locale?: string | string[]): string {
    if (value === null) return 'Unknown';
    const negative = value.coefficient.startsWith('-');
    const digits = (negative ? value.coefficient.slice(1) : value.coefficient).padStart(value.scale + 1, '0');
    const magnitude = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
    // Intl accepts a decimal string without converting it to an imprecise Number.
    const decimal = `${negative ? '-' : ''}${magnitude}` as Intl.StringNumericLiteral;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency, currencyDisplay: 'code', minimumFractionDigits: value.scale, maximumFractionDigits: value.scale }).format(decimal);
}

export function formatCalendarDate(value: string | null, locale?: string | string[]): string {
    if (value === null) return 'Unknown';
    // A booking day has no local time zone, including in years 0001–0099.
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`));
}
