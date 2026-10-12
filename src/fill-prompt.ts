import type { FillDirection, FillMode } from './fill';

export function parseFillDirection(value: string | null | undefined): FillDirection | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === 'down' || normalized === 'abajo') {return 'down';}
	if (normalized === 'right' || normalized === 'derecha') {return 'right';}
	return undefined;
}

export function parseFillMode(value: string | null | undefined): FillMode | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === 'repeat' || normalized === 'repetir') {return 'repeat';}
	if (normalized === 'series' || normalized === 'serie') {return 'series';}
	return undefined;
}
