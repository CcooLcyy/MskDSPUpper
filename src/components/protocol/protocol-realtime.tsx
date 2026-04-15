import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Tag, Typography } from 'antd';
import { api } from '../../adapters';
import type { DcPointUpdate, DcPointValue } from '../../adapters';
import { formatAutoRealtimeNumber } from '../../utils/realtime-value';

const { Text } = Typography;

const QUALITY_META: Record<number, { label: string; color: string }> = {
  0: { label: '未指定', color: 'default' },
  1: { label: '正常', color: 'green' },
  2: { label: '异常', color: 'red' },
  3: { label: '不确定', color: 'orange' },
};

export const PROTOCOL_SHADOW_UPDATE_EVENT = 'protocol-shadow-update';
const PROTOCOL_SHADOW_SNAPSHOT_REFRESH_MS = 500;

export type ProtocolRealtimeCellRevision = {
  value: number;
  timestamp: number;
  quality: number;
};

type ProtocolRealtimeState = {
  realtimeByTag: Record<string, DcPointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
};

function createEmptyRealtimeCellRevision(): ProtocolRealtimeCellRevision {
  return {
    value: 0,
    timestamp: 0,
    quality: 0,
  };
}

function createEmptyRealtimeState(): ProtocolRealtimeState {
  return {
    realtimeByTag: {},
    realtimeRevisionByTag: {},
  };
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function buildUpdateMap(updates: DcPointUpdate[], sourceConnId: number): Record<string, DcPointUpdate> {
  const next: Record<string, DcPointUpdate> = {};
  for (const update of updates) {
    if (update.src_conn_id === sourceConnId) {
      next[update.src_tag] = update;
    }
  }
  return next;
}

function arePointValuesEqual(
  left: DcPointValue | null | undefined,
  right: DcPointValue | null | undefined,
): boolean {
  if (left == null || right == null) {
    return left == null && right == null;
  }

  if (left.type !== right.type) {
    return false;
  }

  if (left.type === 'Bytes' && right.type === 'Bytes') {
    if (left.value.length !== right.value.length) {
      return false;
    }

    return left.value.every((value, index) => value === right.value[index]);
  }

  return left.value === right.value;
}

function arePointUpdatesEqual(left: DcPointUpdate | undefined, right: DcPointUpdate): boolean {
  if (!left) {
    return false;
  }

  return left.src_conn_id === right.src_conn_id
    && left.src_tag === right.src_tag
    && left.dst_conn_id === right.dst_conn_id
    && left.dst_tag === right.dst_tag
    && left.ts_ms === right.ts_ms
    && left.quality === right.quality
    && arePointValuesEqual(left.value, right.value);
}

function getNextRealtimeCellRevision(
  previousUpdate: DcPointUpdate | undefined,
  nextUpdate: DcPointUpdate,
  previousRevision: ProtocolRealtimeCellRevision | undefined,
): ProtocolRealtimeCellRevision {
  if (!previousUpdate) {
    return previousRevision ?? createEmptyRealtimeCellRevision();
  }

  const nextRevision = previousRevision
    ? { ...previousRevision }
    : createEmptyRealtimeCellRevision();

  if (!arePointValuesEqual(previousUpdate.value, nextUpdate.value)) {
    nextRevision.value += 1;
  }

  if (previousUpdate.ts_ms !== nextUpdate.ts_ms) {
    nextRevision.timestamp += 1;
  }

  if (previousUpdate.quality !== nextUpdate.quality) {
    nextRevision.quality += 1;
  }

  return nextRevision;
}

function mergeRealtimeUpdates(
  previous: ProtocolRealtimeState,
  updatesByTag: Record<string, DcPointUpdate>,
): ProtocolRealtimeState {
  let changed = false;
  const nextRealtimeByTag = { ...previous.realtimeByTag };
  const nextRealtimeRevisionByTag = { ...previous.realtimeRevisionByTag };

  for (const [tag, update] of Object.entries(updatesByTag)) {
    const previousUpdate = previous.realtimeByTag[tag];

    if (arePointUpdatesEqual(previousUpdate, update)) {
      continue;
    }

    changed = true;
    nextRealtimeByTag[tag] = update;
    nextRealtimeRevisionByTag[tag] = getNextRealtimeCellRevision(
      previousUpdate,
      update,
      nextRealtimeRevisionByTag[tag],
    );
  }

  return changed
    ? {
        realtimeByTag: nextRealtimeByTag,
        realtimeRevisionByTag: nextRealtimeRevisionByTag,
      }
    : previous;
}

export function useProtocolShadowRealtime(
  sourceConnId: number | null | undefined,
  tags: string[],
): {
  realtimeByTag: Record<string, DcPointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  loading: boolean;
  error: string | null;
} {
  const normalizedTags = useMemo(() => normalizeTags(tags), [tags]);
  const tagSignature = normalizedTags.join('\u0001');
  const hasSelection = Boolean(sourceConnId && normalizedTags.length > 0);
  const activeConnIdRef = useRef<number | null>(sourceConnId ?? null);
  const activeTagSetRef = useRef<Set<string>>(new Set(normalizedTags));
  const pendingUpdatesRef = useRef<Record<string, DcPointUpdate>>({});
  const flushFrameRef = useRef<number | null>(null);
  const snapshotRefreshInFlightRef = useRef(false);
  const [realtimeState, setRealtimeState] = useState<ProtocolRealtimeState>(() => createEmptyRealtimeState());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetPendingUpdates = useEffectEvent(() => {
    pendingUpdatesRef.current = {};
    if (flushFrameRef.current != null) {
      window.cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
  });

  const flushPendingUpdates = useEffectEvent(() => {
    flushFrameRef.current = null;

    const pendingEntries = Object.entries(pendingUpdatesRef.current);
    if (pendingEntries.length === 0) {
      return;
    }

    pendingUpdatesRef.current = {};

    setRealtimeState((previous) =>
      mergeRealtimeUpdates(previous, Object.fromEntries(pendingEntries)),
    );
  });

  const schedulePendingFlush = useEffectEvent(() => {
    if (flushFrameRef.current != null) {
      return;
    }

    flushFrameRef.current = window.requestAnimationFrame(() => {
      flushPendingUpdates();
    });
  });

  const refreshLatestSnapshot = useEffectEvent(async (connId: number, targetTags: string[]) => {
    if (snapshotRefreshInFlightRef.current) {
      return;
    }

    snapshotRefreshInFlightRef.current = true;

    try {
      const updates = await api.dcGetProtocolShadowLatest(connId, targetTags);
      setRealtimeState((previous) => mergeRealtimeUpdates(previous, buildUpdateMap(updates, connId)));
    } catch (reason) {
      setError(String(reason));
    } finally {
      snapshotRefreshInFlightRef.current = false;
    }
  });

  useEffect(() => {
    activeConnIdRef.current = sourceConnId ?? null;
    activeTagSetRef.current = new Set(normalizedTags);
  }, [sourceConnId, normalizedTags]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<DcPointUpdate>(PROTOCOL_SHADOW_UPDATE_EVENT, ({ payload }) => {
      if (payload.src_conn_id !== activeConnIdRef.current) {
        return;
      }
      if (!activeTagSetRef.current.has(payload.src_tag)) {
        return;
      }

      pendingUpdatesRef.current = {
        ...pendingUpdatesRef.current,
        [payload.src_tag]: payload,
      };
      schedulePendingFlush();
    }).then((dispose) => {
      if (disposed) {
        void dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      resetPendingUpdates();
      if (unlisten) {
        void unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!hasSelection || !sourceConnId) {
      resetPendingUpdates();
      setRealtimeState(createEmptyRealtimeState());
      setLoading(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      resetPendingUpdates();
      setRealtimeState(createEmptyRealtimeState());
      setLoading(true);
      setError(null);

      try {
        await api.dcStartProtocolShadowStream();
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
        }
      }

      try {
        const updates = await api.dcGetProtocolShadowLatest(sourceConnId, normalizedTags);
        if (cancelled) {
          return;
        }

        setRealtimeState((previous) => mergeRealtimeUpdates(previous, buildUpdateMap(updates, sourceConnId)));
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      resetPendingUpdates();
    };
  }, [hasSelection, sourceConnId, tagSignature, normalizedTags]);

  useEffect(() => {
    if (!hasSelection || !sourceConnId) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void refreshLatestSnapshot(sourceConnId, normalizedTags);
    }, PROTOCOL_SHADOW_SNAPSHOT_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasSelection, sourceConnId, tagSignature, normalizedTags]);

  return {
    realtimeByTag: hasSelection ? realtimeState.realtimeByTag : {},
    realtimeRevisionByTag: hasSelection ? realtimeState.realtimeRevisionByTag : {},
    loading: hasSelection ? loading : false,
    error: hasSelection ? error : null,
  };
}

export function formatProtocolRealtimeValue(value: DcPointValue | null): string {
  if (!value) {
    return '-';
  }

  switch (value.type) {
    case 'Bool':
      return value.value ? 'true' : 'false';
    case 'Int':
      return String(value.value);
    case 'Double':
      return formatAutoRealtimeNumber(value.value);
    case 'String':
      return value.value;
    case 'Bytes':
      return `[${value.value.length} 字节]`;
    default:
      return '-';
  }
}

export function formatProtocolRealtimeTimestamp(tsMs: number): string {
  if (tsMs <= 0) {
    return '-';
  }

  const date = new Date(tsMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');

  return `${hh}:${mm}:${ss}.${ms}`;
}

function renderProtocolRealtimeCell(
  content: React.ReactNode,
  revision: number | null | undefined,
  options?: { monospace?: boolean },
): React.ReactNode {
  const classNames = ['protocol-realtime-cell'];
  if (revision != null && revision > 0) {
    classNames.push('protocol-realtime-cell--pulse');
  }
  if (options?.monospace) {
    classNames.push('protocol-realtime-cell--mono');
  }

  return (
    <span key={`protocol-realtime-${revision ?? 0}`} className={classNames.join(' ')}>
      {content}
    </span>
  );
}

export function renderProtocolRealtimeQuality(quality: number | null | undefined): React.ReactNode {
  if (quality == null) {
    return <Text type="secondary">-</Text>;
  }

  const meta = QUALITY_META[quality] ?? QUALITY_META[0];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function renderProtocolRealtimePlaceholder(): React.ReactNode {
  return <Text type="secondary">-</Text>;
}

export function renderProtocolRealtimeValueCell(
  update: DcPointUpdate | null | undefined,
  revision: number | null | undefined,
): React.ReactNode {
  if (!update) {
    return renderProtocolRealtimePlaceholder();
  }

  return renderProtocolRealtimeCell(formatProtocolRealtimeValue(update.value), revision);
}

export function renderProtocolRealtimeTimestampCell(
  update: DcPointUpdate | null | undefined,
  revision: number | null | undefined,
): React.ReactNode {
  if (!update) {
    return renderProtocolRealtimePlaceholder();
  }

  return renderProtocolRealtimeCell(
    <Text style={{ fontFamily: '"Consolas", monospace', fontSize: 12 }}>
      {formatProtocolRealtimeTimestamp(update.ts_ms)}
    </Text>,
    revision,
    { monospace: true },
  );
}

export function renderProtocolRealtimeQualityCell(
  update: DcPointUpdate | null | undefined,
  revision: number | null | undefined,
): React.ReactNode {
  if (!update) {
    return renderProtocolRealtimePlaceholder();
  }

  return renderProtocolRealtimeCell(renderProtocolRealtimeQuality(update.quality), revision);
}
