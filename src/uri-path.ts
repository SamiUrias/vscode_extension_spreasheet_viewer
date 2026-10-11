export function uriBasename(value: string, suffix?: string): string {
	const base = value.replace(/\/+$/, '').slice(value.replace(/\/+$/, '').lastIndexOf('/') + 1);
	return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

export function uriDirname(value: string): string {
	const normalized = value.replace(/\/+$/, '');
	const index = normalized.lastIndexOf('/');
	return index <= 0 ? (normalized.startsWith('/') ? '/' : '.') : normalized.slice(0, index);
}

export function uriExtname(value: string): string {
	const base = uriBasename(value);
	const index = base.lastIndexOf('.');
	return index <= 0 ? '' : base.slice(index);
}

export function uriJoin(directory: string, child: string): string {
	const joined = `${directory.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
	const absolute = joined.startsWith('/');
	const segments: string[] = [];
	for (const segment of joined.split('/')) {
		if (!segment || segment === '.') {continue;}
		if (segment === '..') {segments.pop();}
		else {segments.push(segment);}
	}
	return `${absolute ? '/' : ''}${segments.join('/')}` || (absolute ? '/' : '.');
}
