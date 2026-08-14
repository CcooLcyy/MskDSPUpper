import type {
  DcPointValue,
  DcSourcePointUpdate,
  Iec104SimulationPoint,
  Iec104SimulationSnapshot,
} from '../../adapters';

export type Iec104RuntimeDisplay = {
  update: DcSourcePointUpdate | null | undefined;
  simulated: boolean;
};

function toSimulationUpdate(point: Iec104SimulationPoint): DcSourcePointUpdate {
  let value: DcPointValue | null;
  if (point.point_type === 2) {
    value = point.bool_value == null
      ? null
      : { type: 'Bool', value: point.bool_value };
  } else {
    value = point.double_value == null
      ? null
      : { type: 'Double', value: point.double_value };
  }

  return {
    conn_id: 0,
    tag: point.tag,
    value,
    ts_ms: point.ts_ms,
    quality: point.quality,
    sequence: 0,
  };
}

export function buildIec104SimulationUpdates(
  snapshot: Iec104SimulationSnapshot | null | undefined,
): Map<string, DcSourcePointUpdate> {
  return new Map<string, DcSourcePointUpdate>(
    (snapshot?.points ?? []).map((point): [string, DcSourcePointUpdate] => [point.tag, toSimulationUpdate(point)]),
  );
}

export function resolveIec104RuntimeDisplay(
  tag: string,
  simulationUpdates: ReadonlyMap<string, DcSourcePointUpdate>,
  realtimeUpdate: DcSourcePointUpdate | null | undefined,
): Iec104RuntimeDisplay {
  const simulationUpdate = simulationUpdates.get(tag);
  return simulationUpdate
    ? { update: simulationUpdate, simulated: true }
    : { update: realtimeUpdate, simulated: false };
}
