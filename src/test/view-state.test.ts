import * as assert from 'assert';
import { MAX_VIEW_STATE_FILES, MAX_VIEW_STATE_BYTES, ViewStateRepository, validateViewState, type ViewStateV1 } from '../view-state';

suite('Persistent view state', () => {
	test('validates and restores per-file, per-sheet view preferences', () => {
		const memento = new MemoryMemento();
		const repository = new ViewStateRepository(memento);
		const state = makeState('file:///cities.csv');
		assert.strictEqual(repository.write(state, state.uri, state.mode), true);
		const restored = repository.read(state.uri, state.mode);
		assert.strictEqual(restored.corrupted, false);
		assert.deepStrictEqual(restored.state?.sheets['sheet:0']?.selection, { row: 53, column: 1 });
		assert.strictEqual(restored.state?.sheets['sheet:0']?.query, 'Guatemala');
		assert.deepStrictEqual(restored.state?.sheets['sheet:0']?.filters, makeState(state.uri).sheets['sheet:0']!.filters);
		assert.strictEqual(restored.state?.sheets['sheet:0']?.searchAllRows, true);
	});

	test('keeps edit and preview preferences separate for the same URI', () => {
		const repository = new ViewStateRepository(new MemoryMemento());
		const edit = makeState('file:///shared.csv');
		const preview = { ...makeState(edit.uri), mode: 'preview' as const, sheets: { ...makeState(edit.uri).sheets, 'sheet:0': {
			...makeState(edit.uri).sheets['sheet:0']!, query: 'preview query',
		} } };
		assert.strictEqual(repository.write(edit, edit.uri, 'edit'), true);
		assert.strictEqual(repository.write(preview, preview.uri, 'preview'), true);
		assert.strictEqual(repository.read(edit.uri, 'edit').state?.sheets['sheet:0']?.query, 'Guatemala');
		assert.strictEqual(repository.read(edit.uri, 'preview').state?.sheets['sheet:0']?.query, 'preview query');
	});

	test('ignores malformed state and rejects oversized preferences', () => {
		const corrupt = makeState('file:///bad.csv') as unknown as Record<string, unknown>;
		corrupt.sheets = { bad: { query: 'x', scroll: { top: -1, left: 0 } } };
		assert.strictEqual(validateViewState(corrupt, 'file:///bad.csv', 'edit'), undefined);
		const large = makeState('file:///large.csv');
		large.sheets['sheet:0']!.query = 'x'.repeat(MAX_VIEW_STATE_BYTES);
		assert.strictEqual(validateViewState(large, large.uri, large.mode), undefined);
	});

	test('migrates V1 view states written before filters were added', () => {
		const oldState = makeState('file:///old.csv');
		const oldSheet = oldState.sheets['sheet:0']! as unknown as Record<string, unknown>;
		delete oldSheet.filters; delete oldSheet.searchAllRows;
		const migrated = validateViewState(oldState, oldState.uri, oldState.mode);
		assert.deepStrictEqual(migrated?.sheets['sheet:0']?.filters, []);
		assert.strictEqual(migrated?.sheets['sheet:0']?.searchAllRows, false);
	});

	test('keeps the most recently used 100 file/mode records', () => {
		const memento = new MemoryMemento();
		const repository = new ViewStateRepository(memento);
		for (let index = 0; index <= MAX_VIEW_STATE_FILES; index++) {
			const state = makeState(`file:///file-${index}.csv`);
			state.updatedAt = index;
			assert.strictEqual(repository.write(state, state.uri, state.mode), true);
		}
		const records = memento.get<Record<string, unknown>>('spreadsheet-viewer.viewState.v1')!;
		assert.strictEqual(Object.keys(records).length, MAX_VIEW_STATE_FILES);
		assert.strictEqual(repository.read('file:///file-0.csv', 'edit').state, undefined);
		assert.ok(repository.read(`file:///file-${MAX_VIEW_STATE_FILES}.csv`, 'edit').state);
	});
});

class MemoryMemento {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {return this.values.get(key) as T | undefined;}
	update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {this.values.delete(key);} else {this.values.set(key, structuredClone(value));}
		return Promise.resolve();
	}
}

function makeState(uri: string): ViewStateV1 {
	return {
		version: 1, uri, mode: 'edit', schema: 'csv-v1', activeSheetId: 'sheet:0', updatedAt: 1,
		sheets: { 'sheet:0': {
			schema: 'columns:3', query: 'Guatemala', selection: { row: 53, column: 1 }, scroll: { top: 1200, left: 64 },
			sort: [{ column: 1, direction: 'asc', mode: 'text' }], filters: [{ column: 2, kind: 'conditions', join: 'and', conditions: [{ operator: 'startsWith', mode: 'text', value: 'America' }] }],
			columnWidths: { '1': 220 }, rowHeights: { '53': 34 }, showComments: false, searchAllRows: true,
		} },
	};
}
