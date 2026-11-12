import type { CSSProperties } from 'react';

export type TooltipAnchor = { x: number; y: number; bottom: number };

export function tooltipPlacement(position: TooltipAnchor): {
  panel: CSSProperties;
  arrow: CSSProperties;
} {
  const below = position.y < 120;
  const shift = `clamp(calc(8px - ${position.x}px), -50%, calc(100vw - 8px - ${position.x}px - 100%))`;
  return {
    panel: {
      left: position.x,
      top: below ? position.bottom : position.y,
      maxWidth: 'calc(100vw - 16px)',
      transform: `translateX(${shift}) translateY(${below ? '8px' : 'calc(-100% - 8px)'})`,
    },
    arrow: { left: `calc(0px - ${shift})`, ...(below ? { top: -4 } : { bottom: -4 }) },
  };
}
