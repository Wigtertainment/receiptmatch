import { formatAmountEntry } from './amount-entry.js';
import type { Money } from './money.js';

export const defaultExportFilenamePattern = '{date}_{counterparty}_{currency}_{amount}';
export const exportFilenamePatternLimit = 160;

interface ExportFilenameData {
	date: string;
	counterparty: string | null;
	amount: Money;
	extension: 'pdf' | 'png' | 'jpg' | 'jpeg';
}

export const exportFilenameExample: ExportFilenameData = {
	date: '2026-10-21',
	counterparty: 'Example Merchant',
	amount: { currency: 'EUR', coefficient: '-17677', scale: 2 },
	extension: 'pdf',
};

const unsafeCharacters = /[<>:"/\\|?*]/;
const reservedName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:[. ]|$)/i;
const utf8 = new TextEncoder();

function isControl(character: string): boolean {
	const code = character.charCodeAt(0);
	return code < 32 || (code >= 127 && code <= 159);
}

function safeCounterparty(value: string | null): string {
	const clean = [...(value ?? '').normalize('NFC')].map(character => unsafeCharacters.test(character) || /[\s{}]/u.test(character) || isControl(character) ? '-' : character)
		.join('').replace(/-+/g, '-').replace(/^[. -]+|[. -]+$/g, '');
	let name = '';
	for (const character of clean) {
		if (utf8.encode(name + character).length > 80) break;
		name += character;
	}
	name = name.replace(/[. -]+$/g, '') || 'Unknown';
	return reservedName.test(name) ? '_' + name : name;
}

export function renderExportFilename(pattern: string, data: ExportFilenameData): { filename: string; error?: never } | { filename?: never; error: string } {
	const template = pattern.trim();
	if (!template || pattern.length > exportFilenamePatternLimit) return { error: 'Enter a pattern of up to 160 characters.' };
	if (unsafeCharacters.test(pattern) || [...pattern].some(isControl)) return { error: 'Use a filename pattern without folder separators or other invalid characters.' };
	const values = new Map([
		['date', data.date], ['counterparty', safeCounterparty(data.counterparty)], ['currency', data.amount.currency], ['amount', formatAmountEntry(data.amount, '.')],
	]);
	const stem = template.replace(/\{([^{}]+)\}/g, (match: string, token: string) => values.get(token) ?? match);
	if (/[{}]/.test(stem)) return { error: 'Use only the listed placeholders, including both braces.' };
	if (unsafeCharacters.test(stem) || [...stem].some(isControl)) return { error: 'The generated filename contains invalid characters.' };
	if (!stem || stem === '.' || stem === '..' || stem.endsWith('.') || reservedName.test(stem)) return { error: 'Enter a portable filename without a reserved name or trailing period.' };
	const filename = stem + '.' + data.extension;
	if (utf8.encode(filename).length > 255) return { error: 'The generated filename is too long.' };
	return { filename };
}
