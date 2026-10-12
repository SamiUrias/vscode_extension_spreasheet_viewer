import messages from './messages';
import es from './es';

export type UiLocale = 'en' | 'es';
export type MessageKey = keyof typeof messages;

let locale: UiLocale = 'en';

export function resolveLocale(language: string): UiLocale {
	const normalized = language.toLowerCase().replace(/_/g, '-');
	return normalized === 'es' || normalized.startsWith('es-') ? 'es' : 'en';
}

export function configureLocale(language: string): void {
	locale = resolveLocale(language);
}

export function setActiveLocale(value: unknown): UiLocale | undefined {
	if (value !== 'en' && value !== 'es') {return undefined;}
	if (locale !== value) {locale = value;}
	return locale;
}

export function getLocale(): UiLocale {
	return locale;
}

export function t(key: MessageKey, ...args: Array<string | number | boolean>): string {
	const translated = locale === 'es' ? es[key] : undefined;
	const template: string = translated || messages[key];
	return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? placeholder : String(value);
	});
}

export function formatUiNumber(value: number): string {
	return new Intl.NumberFormat(locale).format(value);
}
