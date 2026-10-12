import type { MessageKey } from './index';

const es = {
	'ui.loading': 'Cargando hoja de cálculo…',
	'ui.sheetCount': '{0} hojas',
	'ui.rowCount': '{0} filas',
	'ui.openFailed': 'No se pudo abrir {0}: {1}',
	'ui.actionFailed': 'No se pudo {0} {1}.',
	'ui.rawValue': 'Valor crudo',
	'ui.resetView': 'Restablecer vista',
	'ui.autoFitColumn': 'Autoajustar columna',
} satisfies Record<MessageKey, string>;

export default es;
