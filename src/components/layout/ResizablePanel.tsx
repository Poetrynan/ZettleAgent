import { useState, useCallback, useRef, useEffect, ReactNode } from 'react';

interface ResizablePanelProps {
  children: ReactNode;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  side: 'left' | 'right';
  storageKey?: string;
  style?: React.CSSProperties;
}

export function ResizablePanel({
  children,
  defaultWidth,
  minWidth = 150,
  maxWidth = 600,
  side,
  storageKey,
  style,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed;
      }
    }
    return defaultWidth;
  });

  const [isDragging, setIsDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const widthRef = useRef(width);

  // Keep ref in sync
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    startX.current = e.clientX;
    startWidth.current = widthRef.current;
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Left panel: handle is on right edge, dragging right = wider
      // Right panel: handle is on left edge, dragging left = wider
      const delta = side === 'left'
        ? e.clientX - startX.current
        : startX.current - e.clientX;

      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth.current + delta));
      widthRef.current = newWidth;
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      if (storageKey) {
        localStorage.setItem(storageKey, String(widthRef.current));
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, side, minWidth, maxWidth, storageKey]);

  const resizeHandle = (
    <div
      className={`resize-handle ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
      style={{ width: '3px', cursor: 'col-resize', flexShrink: 0, position: 'relative', zIndex: 10 }}
    />
  );

  return (
    <div style={{ display: 'flex', flexShrink: 0, height: '100%', ...style }}>
      {side === 'right' && resizeHandle}
      <div style={{ width: `${width}px`, height: '100%', overflow: 'hidden', flexShrink: 0 }}>
        {children}
      </div>
      {side === 'left' && resizeHandle}
    </div>
  );
}
