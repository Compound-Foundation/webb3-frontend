import React, { cloneElement, useEffect, useRef, useState } from 'react';

import Portal from './Portal';

type TooltipCoordinates = {
  x: number;
  y: number;
};

// Minimum distance (px) kept between the tooltip and the viewport edges.
const VIEWPORT_MARGIN = 8;

const Tooltip = ({
  width,
  children,
  content,
  under = false,
  hideArrow = false,
  mini = false,
  disabled = false,
  interactive = false,
  yOffset = 20,
  x,
  y,
}: {
  width: number;
  children: React.ReactElement;
  content: React.ReactNode;
  under?: boolean;
  hideArrow?: boolean;
  mini?: boolean;
  disabled?: boolean;
  interactive?: boolean;
  yOffset?: number;
  x?: number;
  y?: number;
}) => {
  const [showTooltip, setShowTooltip] = useState<boolean>(false);
  const [coordinates, setCoordinates] = useState<TooltipCoordinates>({ x: 0, y: 0 });
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const [caretLeft, setCaretLeft] = useState<number | undefined>(undefined);
  const tooltipRef = useRef<null | HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const touchMoved = useRef(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseOver = (e: any) => {
    if (!disabled && tooltipRef.current) {
      triggerRef.current = e.currentTarget;
      setShowTooltip(true);
      const triggerEl = e.currentTarget.getBoundingClientRect();

      const tooltipHeight = tooltipRef.current.clientHeight;
      // By default, try to set the tooltip above the hovered element.
      let yCoords = triggerEl.bottom - tooltipHeight - triggerEl.height - yOffset;
      let below = false;
      if (under) {
        // Deliberately anchor below the trigger, with a gap.
        yCoords = triggerEl.bottom + yOffset;
        below = true;
        // Flip back above if that would run past the bottom of the viewport.
        if (yCoords + tooltipHeight > window.innerHeight - VIEWPORT_MARGIN) {
          yCoords = triggerEl.top - tooltipHeight - yOffset;
          below = false;
        }
      } else if (yCoords < -yOffset) {
        // If the tooltip would get cut off above the screen, then move it
        // below the hovered element instead.
        yCoords = triggerEl.bottom;
        below = true;
      }
      // The caret flips to whichever edge faces the trigger.
      setPlacement(below ? 'below' : 'above');

      // Center the tooltip on the trigger, but clamp it inside the viewport;
      // when clamping shifts it, offset the caret so it still points at the trigger.
      const centeredX = triggerEl.left + triggerEl.width / 2 - width / 2;
      const clampedX = Math.max(VIEWPORT_MARGIN, Math.min(centeredX, window.innerWidth - width - VIEWPORT_MARGIN));
      const triggerCenter = triggerEl.left + triggerEl.width / 2;
      setCaretLeft(
        x === undefined
          ? Math.max(VIEWPORT_MARGIN, Math.min(triggerCenter - clampedX - 7, width - VIEWPORT_MARGIN - 14))
          : undefined
      );

      setCoordinates({
        x: x || clampedX,
        y: y || yCoords,
      });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseOut = (e?: any) => {
    // For interactive tooltips, keep showing while the pointer is moving within
    // the trigger or onto the tooltip itself (they render flush against each
    // other); hide immediately as soon as it leaves both.
    if (interactive) {
      const next: Node | null = e?.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (next !== null && (tooltipRef.current?.contains(next) || triggerRef.current?.contains(next))) {
        return;
      }
    }
    setShowTooltip(false);
  };

  // Touch support for interactive tooltips: hover never fires on touch devices,
  // so a tap on the trigger toggles the tooltip instead. preventDefault on
  // touchend suppresses the browser's synthesized mouse events (mouseover/click),
  // which would otherwise double-fire the hover path and undo the toggle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleTouchEnd = (e: any) => {
    if (touchMoved.current) return; // scroll gesture, not a tap
    if (disabled || !tooltipRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    triggerRef.current = e.currentTarget;
    if (showTooltip) {
      setShowTooltip(false);
    } else {
      handleMouseOver(e);
    }
  };

  // While an interactive tooltip is open, a tap anywhere outside it (and outside
  // its trigger, whose own touchend handles the toggle) dismisses it.
  useEffect(() => {
    if (!interactive || !showTooltip) return;
    const onDocumentTouchStart = (e: TouchEvent) => {
      const target = e.target as Node;
      if (tooltipRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setShowTooltip(false);
    };
    document.addEventListener('touchstart', onDocumentTouchStart);
    return () => document.removeEventListener('touchstart', onDocumentTouchStart);
  }, [interactive, showTooltip]);
  return (
    <>
      {disabled
        ? children
        : cloneElement(children, {
            onMouseOver: handleMouseOver,
            onMouseOut: handleMouseOut,
            ...(interactive && {
              onTouchStart: () => (touchMoved.current = false),
              onTouchMove: () => (touchMoved.current = true),
              onTouchEnd: handleTouchEnd,
            }),
          })}
      {disabled || (
        <Portal>
          <span
            className={`tooltip tooltip${!showTooltip && '--inactive'} tooltip${hideArrow && '--hide-arrow'} tooltip${
              mini && '--mini'
            } tooltip${placement === 'below' && '--below'} tooltip${interactive && '--interactive'}`}
            id="tooltip"
            ref={tooltipRef}
            style={
              {
                width: width,
                left: coordinates.x,
                top: coordinates.y,
                ...(caretLeft !== undefined && { '--tooltip-caret-left': `${caretLeft}px` }),
              } as React.CSSProperties
            }
            {...(interactive && {
              onMouseOut: handleMouseOut,
              // Clicks on tooltip content are portal-rendered but still bubble up
              // the React tree to the trigger's ancestors (e.g. the rewards
              // dropdown toggle), and the native mousedown would hit
              // useOnClickOutside handlers. Contain both.
              onClick: (e: React.MouseEvent) => e.stopPropagation(),
              onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
            })}
          >
            {content}
          </span>
        </Portal>
      )}
    </>
  );
};

export default Tooltip;
