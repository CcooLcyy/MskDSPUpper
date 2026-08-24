import type { DcPointUpdate, DcSourcePointUpdate } from '../adapters';

export type ControlRuntimeUpdates = Record<string, DcPointUpdate>;

const toDestinationUpdate = (update: DcSourcePointUpdate): DcPointUpdate => ({
  src_conn_id: update.conn_id,
  src_tag: update.tag,
  dst_conn_id: update.conn_id,
  dst_tag: update.tag,
  value: update.value,
  ts_ms: update.ts_ms,
  quality: update.quality,
});

export const mergeControlRuntimeUpdates = (
  destinationUpdates: DcPointUpdate[],
  sourceUpdates: DcSourcePointUpdate[],
): ControlRuntimeUpdates => {
  const updates: ControlRuntimeUpdates = {};

  destinationUpdates.forEach((update) => {
    const tag = update.dst_tag || update.src_tag;
    if (tag) {
      updates[tag] = update;
    }
  });

  // 控制模块自己发布的设定值/派生点属于源端缓存，按源端值覆盖同名目的端值。
  sourceUpdates.forEach((update) => {
    if (update.tag) {
      updates[update.tag] = toDestinationUpdate(update);
    }
  });

  return updates;
};
