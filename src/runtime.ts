export interface RuntimeCrypto {
	randomUUID(): string;
	getRandomValues(array: Uint8Array): Uint8Array;
	subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

let runtimeCrypto: RuntimeCrypto | undefined = globalThis.crypto;

export function setRuntimeCrypto(provider: RuntimeCrypto): void {
	runtimeCrypto = provider;
}

function cryptoProvider(): RuntimeCrypto {
	if (!runtimeCrypto) {throw new Error('Este entorno no ofrece Web Crypto.');}
	return runtimeCrypto;
}

export function createUuid(): string {
	return cryptoProvider().randomUUID();
}

export function randomBase64(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	cryptoProvider().getRandomValues(bytes);
	return bytesToBase64(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let start = 0; start < bytes.length; start += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
	}
	return globalThis.btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
	const binary = globalThis.atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {bytes[index] = binary.charCodeAt(index);}
	return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await cryptoProvider().subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
