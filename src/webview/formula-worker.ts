import type { FormulaEvaluation } from '../protocol';

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

workerScope.addEventListener('message', event => {
	const request = event.data as FormulaCalculationRequest;
	if (request?.type !== 'calculate') {return;}
	void calculate(request);
});

async function calculate(request: FormulaCalculationRequest): Promise<void> {
	try {
		// The worker is loaded from a blob URL, so point webpack's async WASM
		// fetch at the extension's packaged resource URI before loading the calculator.
		__webpack_public_path__ = request.wasmBaseUri;
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
