import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './resizable-split.css';

interface ResizableSplitProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  orientation?: 'horizontal' | 'vertical';
  defaultSize: number;
  minSize: number;
  maxSize: number;
  storageKey?: string;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const readStoredSize = (storageKey: string | undefined, defaultSize: number, minSize: number, maxSize: number): number => {
  if (!storageKey || typeof window === 'undefined') {
    return clamp(defaultSize, minSize, maxSize);
  }

  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) ? clamp(stored, minSize, maxSize) : clamp(defaultSize, minSize, maxSize);
  } catch {
    return clamp(defaultSize, minSize, maxSize);
  }
};

const ResizableSplit: React.FC<ResizableSplitProps> = ({
  children,
  className,
  style,
  orientation = 'horizontal',
  defaultSize,
  minSize,
  maxSize,
  storageKey,
}) => {
  const panes = useMemo(() => React.Children.toArray(children).slice(0, 2), [children]);
  const [size, setSize] = useState(() => readStoredSize(storageKey, defaultSize, minSize, maxSize));
  const dragRef = useRef<{ startCoordinate: number; startSize: number } | null>(null);
  const isVertical = orientation === 'vertical';

  const updateSize = useCallback((nextSize: number) => {
    setSize(clamp(nextSize, minSize, maxSize));
  }, [maxSize, minSize]);

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(storageKey, String(size));
    } catch {
      // Persistence is optional and can be unavailable in restricted browser contexts.
    }
  }, [size, storageKey]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragRef.current) {
        return;
      }
      const coordinate = isVertical ? event.clientY : event.clientX;
      updateSize(dragRef.current.startSize + coordinate - dragRef.current.startCoordinate);
    };
    const handlePointerUp = () => {
      dragRef.current = null;
      document.body.classList.remove('resizable-split-dragging', 'resizable-split-dragging--vertical');
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      document.body.classList.remove('resizable-split-dragging', 'resizable-split-dragging--vertical');
    };
  }, [isVertical, updateSize]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragRef.current = { startCoordinate: isVertical ? event.clientY : event.clientX, startSize: size };
    document.body.classList.add('resizable-split-dragging');
    if (isVertical) {
      document.body.classList.add('resizable-split-dragging--vertical');
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const decreaseKey = isVertical ? 'ArrowUp' : 'ArrowLeft';
    const increaseKey = isVertical ? 'ArrowDown' : 'ArrowRight';
    if (event.key === decreaseKey) {
      event.preventDefault();
      updateSize(size - step);
    } else if (event.key === increaseKey) {
      event.preventDefault();
      updateSize(size + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      updateSize(minSize);
    } else if (event.key === 'End') {
      event.preventDefault();
      updateSize(maxSize);
    }
  };

  const handleDoubleClick = () => {
    updateSize(defaultSize);
  };

  return (
    <div className={`resizable-split${isVertical ? ' resizable-split--vertical' : ''}${className ? ` ${className}` : ''}`} style={style}>
      <div className="resizable-split-pane resizable-split-pane--first" style={{ flexBasis: size }}>
        {panes[0]}
      </div>
      <div
        className="resizable-split-divider"
        role="separator"
        aria-label={isVertical ? '调整上方面板高度' : '调整左侧面板宽度'}
        aria-orientation={isVertical ? 'horizontal' : 'vertical'}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        aria-valuenow={Math.round(size)}
        tabIndex={0}
        title={isVertical ? '拖动调整面板高度，双击恢复默认' : '拖动调整面板宽度，双击恢复默认'}
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      />
      <div className="resizable-split-pane resizable-split-pane--second">
        {panes[1]}
      </div>
    </div>
  );
};

export default ResizableSplit;
