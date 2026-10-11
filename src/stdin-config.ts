let stdinTemporaryDirectory: string | undefined;

export function setStdinTemporaryDirectory(directory: string): void {
	stdinTemporaryDirectory = directory;
}

export function getStdinTemporaryDirectory(): string | undefined {
	return stdinTemporaryDirectory;
}
