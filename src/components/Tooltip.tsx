import React, { cloneElement, useEffect, useRef, useState } from 'react';

import Portal from './Portal';

type TooltipCoordinates = {
  x: number;
  y: number;
};

// Grace period (ms) before an interactive tooltip hides after the pointer leaves
// the trigger, giving the user time to move onto the tooltip to click its content.
const HIDE_DELAY_MS = 150;

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
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const touchMoved = useRef(false);

  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  useEffect(() => clearHideTimer, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseOver = (e: any) => {
    if (!disabled && tooltipRef.current) {
      clearHideTimer();
      setShowTooltip(true);
      const triggerEl = e.currentTarget.getBoundingClientRect();

      // By default, try to set the tooltip above the hovered element.
      let yCoords = triggerEl.bottom - tooltipRef.current.clientHeight - triggerEl.height - yOffset;
      if (under) {
        // Deliberately anchor below the trigger, with a gap, and flip the caret up.
        yCoords = triggerEl.bottom + yOffset;
        setPlacement('below');
      } else if (yCoords < -yOffset) {
        // If the tooltip would get cut off above the screen, then move it
        // below the hovered element instead.
        yCoords = triggerEl.bottom;
        setPlacement('above');
      } else {
        setPlacement('above');
      }

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
  const handleMouseOut = () => {
    // For interactive tooltips, delay hiding so the pointer can travel from the
    // trigger onto the tooltip (where onMouseOver cancels the pending hide).
    if (interactive) {
      clearHideTimer();
      hideTimer.current = setTimeout(() => setShowTooltip(false), HIDE_DELAY_MS);
    } else {
      setShowTooltip(false);
    }
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
            } tooltip${placement === 'below' && !hideArrow && '--below'} tooltip${interactive && '--interactive'}`}
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
              onMouseOver: clearHideTimer,
              onMouseOut: handleMouseOut,
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
