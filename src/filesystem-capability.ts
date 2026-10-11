/** Unknown file-system capabilities are treated as read-only until the provider confirms writes. */
export function isWritableFileSystem(capability: boolean | undefined): boolean {
	return capability === true;
}

export function isDocumentMutationMessageType(type: string): boolean {
	return ['editCell', 'editFormula', 'editCells', 'csvRowOperation', 'xlsxStructureOperation', 'history', 'draftState'].includes(type);
}
