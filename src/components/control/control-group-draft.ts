import type { ControlMappingField } from '../../utils/control-mapping-editor';
import type { ControlMappingDraft } from './useControlMappings';

export interface ControlGroupDraft<Config, Values, Member, Endpoints> {
  original: { connId: number; fingerprint: string } | null;
  editingGroup: Config | null;
  values: Values;
  allocationMode: 'equal' | 'proportional' | 'custom';
  members: Member[];
  removedMemberFields: ControlMappingField[];
  mapping?: ControlMappingDraft;
  member?: {
    index: number | null;
    values: Member;
    endpoints: Endpoints;
    initialEndpoints: Endpoints;
    endpointChanges: Endpoints;
  };
}

export const controlDraftFingerprint = (value: unknown): string => JSON.stringify(value, (_key, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item
));
