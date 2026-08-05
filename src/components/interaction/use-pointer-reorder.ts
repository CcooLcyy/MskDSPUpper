import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type ActivePointerDrag = {
  key: string;
  pointerId: number;
};

type PointerReorderOptions = {
  disabled?: boolean;
  onReorder: (fromKey: string, toKey: string) => void;
};

type PointerReorderHandlers = {
  activeKey: string | null;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, key: string) => void;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>, key: string) => void;
  cancel: () => void;
};

const INTERACTIVE_TARGET_SELECTOR = 'button, input, textarea, select, [contenteditable="true"], [role="button"], .ant-select, .ant-input-number';

const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest(INTERACTIVE_TARGET_SELECTOR));

/**
 * Uses pointer events for row sorting because some desktop WebViews do not
 * reliably emit the native HTML5 drag/drop event sequence.
 */
export const usePointerReorder = ({ disabled = false, onReorder }: PointerReorderOptions): PointerReorderHandlers => {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const dragRef = useRef<ActivePointerDrag | null>(null);

  const cancel = useCallback(() => {
    dragRef.current = null;
    setActiveKey(null);
  }, []);

  useEffect(() => {
    const handlePointerEnd = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        cancel();
      }
    };

    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    if (!activeKey) return undefined;
    document.body.classList.add('pointer-reorder-active');
    return () => document.body.classList.remove('pointer-reorder-active');
  }, [activeKey]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, key: string) => {
    if (disabled || isInteractiveTarget(event.target)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { key, pointerId: event.pointerId };
    setActiveKey(key);
  }, [disabled]);

  const onPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>, key: string) => {
    if (disabled) return;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.key === key) return;
    event.preventDefault();
    onReorder(drag.key, key);
  }, [disabled, onReorder]);

  return { activeKey, onPointerDown, onPointerEnter, cancel };
};
