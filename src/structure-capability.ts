import type { SaveStateMessage } from './protocol';

export interface StructureCapabilityState { readonly allowed: boolean; readonly reason?: string; readonly reasonCode?: 'pending-changes'; }

/** Re-enable structural actions only after the transient pending-changes block is saved. */
export function refreshStructureCapabilityAfterSave(
	capability: StructureCapabilityState | undefined,
	state: SaveStateMessage['state'],
): StructureCapabilityState | undefined {
	if ((state === 'saved' || state === 'clean') && capability?.reasonCode === 'pending-changes') {
		return { allowed: true };
	}
	return capability;
}
