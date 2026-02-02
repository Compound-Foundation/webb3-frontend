import React, { cloneElement, useRef, useState } from 'react';

import Portal from './Portal';

type TooltipCoordinates = {
  x: number;
  y: number;
};

const Tooltip = ({
  width,
  children,
  content,
  under = false,
  hideArrow = false,
  mini = false,
  disabled = false,
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
  yOffset?: number;
  x?: number;
  y?: number;
}) => {
  const [showTooltip, setShowTooltip] = useState<boolean>(false);
  const [coordinates, setCoordinates] = useState<TooltipCoordinates>({ x: 0, y: 0 });
  const tooltipRef = useRef<null | HTMLSpanElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseOver = (e: any) => {
    if (!disabled && tooltipRef.current) {
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
  const handleMouseOut = () => setShowTooltip(false);
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
          >
            {content}
          </span>
        </Portal>
      )}
    </>
  );
};

export default Tooltip;
