import type { FormulaEvaluation } from '../protocol';
import { configureLocale, t } from '../i18n';

declare let __webpack_public_path__: string;

interface FormulaCalculationRequest {
	type: 'calculate';
	requestId: number;
	workbookBase64: string;
	revision: number;
	sheetName: string;
	kinds: readonly (readonly string[])[];
	rows?: readonly (readonly string[])[];
	wasmBaseUri: string;
	wasmBase64: string;
	locale: 'en' | 'es';
}

interface FormulaCalculationResponse {
	type: 'result' | 'error';
	requestId: number;
	results?: Record<string, FormulaEvaluation>;
	error?: string;
}

interface FormulaWorkerScope {
	addEventListener(type: 'message', listener: (event: MessageEvent<FormulaCalculationRequest>) => void): void;
	postMessage(message: FormulaCalculationResponse): void;
}

const workerScope = self as unknown as FormulaWorkerScope;
let wasmFetchInstalled = false;

workerScope.addEventListener('message', event => {
	const request = event.data as FormulaCalculationRequest;
	if (request?.type !== 'calculate') {return;}
	void calculate(request);
});

async function calculate(request: FormulaCalculationRequest): Promise<void> {
	try {
		configureLocale(typeof request.locale === 'string' ? request.locale : '');
		if (request.locale !== 'en' && request.locale !== 'es') {throw new Error(t('worker.invalidLocale'));}
		// The worker is loaded from a blob URL, so point webpack at the extension's
		// resource URI. Serve the large WASM response from bytes sent by the host;
		// the vscode-resource proxy can time out on a direct 9.7 MB fetch.
		__webpack_public_path__ = request.wasmBaseUri;
		installWasmFetch(request.wasmBase64);
		const { calculateFormulaResults } = await import('./formula-calculator');
		const results = await calculateFormulaResults(
			request.workbookBase64,
			request.revision,
			request.sheetName,
			request.kinds,
			request.rows,
		);
		workerScope.postMessage({ type: 'result', requestId: request.requestId, results } satisfies FormulaCalculationResponse);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		workerScope.postMessage({ type: 'error', requestId: request.requestId, error: message } satisfies FormulaCalculationResponse);
	}
}

function installWasmFetch(wasmBase64: string): void {
	if (wasmFetchInstalled) {return;}
	if (!wasmBase64) {throw new Error(t('worker.wasmMissing'));}
	const wasmBytes = decodeBase64(wasmBase64);
	const responseBytes = new ArrayBuffer(wasmBytes.byteLength);
	new Uint8Array(responseBytes).set(wasmBytes);
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes('formualizer.wasm')) {
			return Promise.resolve(new Response(responseBytes, { headers: { 'Content-Type': 'application/wasm' } }));
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	wasmFetchInstalled = true;
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {bytes[index] = binary.charCodeAt(index);}
	return bytes;
}
