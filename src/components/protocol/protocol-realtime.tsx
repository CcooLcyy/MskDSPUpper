import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Tag, Typography } from 'antd';
import { api } from '../../adapters';
import type { DcPointValue, DcSourcePointUpdate } from '../../adapters';
import { formatAutoRealtimeNumber } from '../../utils/realtime-value';

const { Text } = Typography;

const QUALITY_META: Record<number, { label: string; color: string }> = {
  0: { label: '未指定', color: 'default' },
  1: { label: '正常', color: 'green' },
  2: { label: '异常', color: 'red' },
  3: { label: '不确定', color: 'orange' },
};

const PROTOCOL_SOURCE_REFRESH_MS = 1000;

export type ProtocolRealtimeCellRevision = {
  value: number;
  timestamp: number;
  quality: number;
};

type ProtocolRealtimeState = {
  realtimeByTag: Record<string, DcSourcePointUpdate>;
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
  return Array.from(new Set(tags.filter((tag) => tag.length > 0)));
}

function buildUpdateMap(
  updates: DcSourcePointUpdate[],
  sourceConnId: number,
): Record<string, DcSourcePointUpdate> {
  const next: Record<string, DcSourcePointUpdate> = {};
  for (const update of updates) {
    if (update.conn_id === sourceConnId) {
      next[update.tag] = update;
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

function arePointUpdatesEqual(
  left: DcSourcePointUpdate | undefined,
  right: DcSourcePointUpdate,
): boolean {
  if (!left) {
    return false;
  }

  return left.conn_id === right.conn_id
    && left.tag === right.tag
    && left.ts_ms === right.ts_ms
    && left.quality === right.quality
    && left.sequence === right.sequence
    && arePointValuesEqual(left.value, right.value);
}

function getNextRealtimeCellRevision(
  previousUpdate: DcSourcePointUpdate | undefined,
  nextUpdate: DcSourcePointUpdate,
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
  updatesByTag: Record<string, DcSourcePointUpdate>,
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

export function useProtocolRealtime(
  sourceConnId: number | null | undefined,
  tags: string[],
): {
  realtimeByTag: Record<string, DcSourcePointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  loading: boolean;
  error: string | null;
} {
  const normalizedTags = useMemo(() => normalizeTags(tags), [tags]);
  const tagSignature = normalizedTags.join('\u0001');
  const hasSelection = Boolean(sourceConnId && normalizedTags.length > 0);
  const activeConnIdRef = useRef<number | null>(sourceConnId ?? null);
  const activeTagSetRef = useRef<Set<string>>(new Set(normalizedTags));
  const requestIdRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshQueuedInitialRef = useRef(false);
  const [realtimeState, setRealtimeState] = useState<ProtocolRealtimeState>(() => createEmptyRealtimeState());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSourceLatest = useEffectEvent(async (
    connId: number,
    targetTags: string[],
    initial: boolean,
  ) => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      refreshQueuedInitialRef.current ||= initial;
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    refreshInFlightRef.current = true;
    if (initial) {
      setLoading(true);
    }

    try {
      const updates = await api.dcGetSourceLatest(connId, targetTags);
      if (requestId !== requestIdRef.current || connId !== activeConnIdRef.current) {
        return;
      }

      const activeTags = activeTagSetRef.current;
      const currentUpdates = Object.fromEntries(
        Object.entries(buildUpdateMap(updates, connId)).filter(([tag]) => activeTags.has(tag)),
      );
      setRealtimeState((previous) => mergeRealtimeUpdates(previous, currentUpdates));
      setError(null);
    } catch (reason) {
      if (requestId === requestIdRef.current && connId === activeConnIdRef.current) {
        setError(String(reason));
      }
    } finally {
      if (requestId === requestIdRef.current && initial) {
        setLoading(false);
      }
      refreshInFlightRef.current = false;

      if (refreshQueuedRef.current) {
        const queuedInitial = refreshQueuedInitialRef.current;
        refreshQueuedRef.current = false;
        refreshQueuedInitialRef.current = false;
        const activeConnId = activeConnIdRef.current;
        if (activeConnId && activeTagSetRef.current.size > 0) {
          void refreshSourceLatest(activeConnId, [...activeTagSetRef.current], queuedInitial);
        }
      }
    }
  });

  useEffect(() => {
    activeConnIdRef.current = sourceConnId ?? null;
    activeTagSetRef.current = new Set(normalizedTags);
    requestIdRef.current += 1;
    refreshQueuedRef.current = false;
    refreshQueuedInitialRef.current = false;

    if (!hasSelection || !sourceConnId) {
      setRealtimeState(createEmptyRealtimeState());
      setLoading(false);
      setError(null);
      return undefined;
    }

    setRealtimeState(createEmptyRealtimeState());
    setError(null);
    setLoading(true);
    void refreshSourceLatest(sourceConnId, normalizedTags, true);

    const timer = window.setInterval(() => {
      void refreshSourceLatest(sourceConnId, normalizedTags, false);
    }, PROTOCOL_SOURCE_REFRESH_MS);

    return () => {
      requestIdRef.current += 1;
      refreshQueuedRef.current = false;
      refreshQueuedInitialRef.current = false;
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
  update: DcSourcePointUpdate | null | undefined,
  revision: number | null | undefined,
): React.ReactNode {
  if (!update) {
    return renderProtocolRealtimePlaceholder();
  }

  return renderProtocolRealtimeCell(formatProtocolRealtimeValue(update.value), revision);
}

export function renderProtocolRealtimeTimestampCell(
  update: DcSourcePointUpdate | null | undefined,
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
  update: DcSourcePointUpdate | null | undefined,
  revision: number | null | undefined,
): React.ReactNode {
  if (!update) {
    return renderProtocolRealtimePlaceholder();
  }

  return renderProtocolRealtimeCell(renderProtocolRealtimeQuality(update.quality), revision);
}
