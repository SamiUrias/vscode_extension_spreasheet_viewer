/** Stable error identity for failures whose wording is localized for users. */
export class ExternalFileConflictError extends Error {
	readonly code = 'external-file-conflict';

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ExternalFileConflictError';
	}
}

export function isExternalFileConflictError(error: unknown): error is ExternalFileConflictError {
	return error instanceof ExternalFileConflictError
		|| Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'external-file-conflict');
}
