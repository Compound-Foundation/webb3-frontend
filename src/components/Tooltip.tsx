import React, { cloneElement, useEffect, useRef, useState } from 'react';

import Portal from './Portal';

type TooltipCoordinates = {
  x: number;
  y: number;
};

// Grace period (ms) before an interactive tooltip hides after the pointer leaves
// the trigger, giving the user time to move onto the tooltip to click its content.
const HIDE_DELAY_MS = 150;

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
  const tooltipRef = useRef<null | HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // If the tooltip would get cut off above the screen, then move it
      // below the hovered element instead.
      if (yCoords < -yOffset || under) {
        yCoords = triggerEl.bottom;
      }

      setCoordinates({
        x: x || triggerEl.left + triggerEl.width / 2 - width / 2,
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
  return (
    <>
      {disabled
        ? children
        : cloneElement(children, {
            onMouseOver: handleMouseOver,
            onMouseOut: handleMouseOut,
          })}
      {disabled || (
        <Portal>
          <span
            className={`tooltip tooltip${!showTooltip && '--inactive'} tooltip${hideArrow && '--hide-arrow'} tooltip${
              mini && '--mini'
            }`}
            id="tooltip"
            ref={tooltipRef}
            style={{ width: width, left: coordinates.x, top: coordinates.y }}
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
