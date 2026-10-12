import * as assert from 'assert';
import es from '../i18n/es';
import { configureLocale, formatUiNumber, getLocale, resolveLocale, t } from '../i18n';

suite('Runtime localization', () => {
	let originalLocale = getLocale();
	setup(() => { originalLocale = getLocale(); });
	teardown(() => configureLocale(originalLocale));

	test('normalizes language tags and falls back to English', () => {
		for (const language of ['es', 'es-MX', 'ES_gt']) {
			assert.strictEqual(resolveLocale(language), 'es');
		}
		for (const language of ['en', 'en-US', 'de', '']) {
			assert.strictEqual(resolveLocale(language), 'en');
		}
		configureLocale('de');
		assert.strictEqual(getLocale(), 'en');
		assert.strictEqual(t('ui.loading'), 'Loading spreadsheet…');
	});

	test('uses Spanish and safely interpolates repeated, reordered, and dollar data', () => {
		configureLocale('es-MX');
		assert.strictEqual(t('ui.openFailed', '$& {0}', '$1 $` $\' {1}'), 'No se pudo abrir $& {0}: $1 $` $\' {1}');
		assert.strictEqual(t('ui.actionFailed', 'guardar', 'documento'), 'No se pudo guardar documento.');
	});

	test('localizes host, preview, storage, and recovery messages in both catalogs', () => {
		configureLocale('en');
		assert.strictEqual(t('preview.panelTitle', 'sales.csv'), 'sales.csv · Preview');
		assert.strictEqual(t('storage.restoreFailedBackupKept', '/tmp/backup'), 'The save failed and the original file could not be restored. A recovery copy was kept at /tmp/backup.');
		assert.strictEqual(t('recovery.copyCorrupted'), 'The recovery copy is corrupted.');
		configureLocale('es');
		assert.strictEqual(t('preview.panelTitle', 'ventas.csv'), 'ventas.csv · Vista previa');
		assert.strictEqual(t('storage.restoreFailedBackupKept', '/tmp/respaldo'), 'Falló el guardado y no se pudo restaurar el archivo original. Se conservó una copia de recuperación en /tmp/respaldo.');
		assert.strictEqual(t('recovery.copyCorrupted'), 'La copia de recuperación está dañada.');
	});

	test('keeps English fallback for defensive missing translations', () => {
		configureLocale('es');
		const catalog = es as Record<string, string | undefined>;
		const saved = catalog['ui.loading'];
		delete catalog['ui.loading'];
		try {
			assert.strictEqual(t('ui.loading'), 'Loading spreadsheet…');
		} finally {
			catalog['ui.loading'] = saved;
		}
	});

	test('formats UI numbers using the selected locale', () => {
		configureLocale('en');
		assert.strictEqual(formatUiNumber(12345), new Intl.NumberFormat('en').format(12345));
		configureLocale('es');
		assert.strictEqual(formatUiNumber(12345), new Intl.NumberFormat('es').format(12345));
	});
});
