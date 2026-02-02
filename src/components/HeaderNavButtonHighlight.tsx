import { Children, PropsWithChildren, cloneElement, useEffect, useRef, useState, ReactElement } from 'react';
import { useLocation } from 'react-router-dom';

type HighlightBoxProperties = {
  left: number;
  top: number;
  width: number;
  visibility: 'visible' | 'hidden';
  transitionDuration: `${number}s`;
};

export const HeaderNavButtonHighlight = ({ children }: PropsWithChildren) => {
  const [highlightBoxProperties, setHighlightBoxProperties] = useState<HighlightBoxProperties>({
    left: 0,
    top: 0,
    width: 100,
    visibility: 'hidden',
    transitionDuration: '0s',
  });

  // Set up a reference to (child) nav buttons, so it's easy to get the
  // dimensions & position if one of them is active (and move the highlight box there).
  const childRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  // Set up a reference to the surrounding wrapper, so that the highlight box can
  // change its position relatively to it.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Set up a reference to know whether a specific nav button is active or not.
  const activeChildren = useRef<Array<boolean>>([]);
  // Update the state of the highlight box upon visitng a new page (or loading
  // for the first time), so that if there is an active nav button, the highlight box
  // is set on it.
  const location = useLocation();

  // When hovering over a (child) nav button, position the highlight box to
  // be right under it, to give the effect that the hovered nav button is highlighted.
  const handleMouseOver = (e: MouseEvent) => {
    // Check that this is a valid nav button that we're hovering over.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (!wrapperRef.current || typeof e?.currentTarget?.getBoundingClientRect !== 'function') {
      return;
    }

    // Get the dimensions of the hovered nav button.
    const targetBoundingRect = (e.currentTarget as HTMLAnchorElement).getBoundingClientRect();
    const wrapperBoundingRect = wrapperRef.current.getBoundingClientRect();

    // If the highlight box is *already* actively visible, then set a transition
    // to slide the box from its current position to the new position.
    const newTransitionDuration = highlightBoxProperties.visibility === 'visible' ? '0.2s' : '0s';

    // Make the highlight box visible if it isn't already, and set it to surround the nav button.
    setHighlightBoxProperties({
      left: targetBoundingRect.left - wrapperBoundingRect.left,
      top:
        targetBoundingRect.bottom - wrapperBoundingRect.bottom - targetBoundingRect.height + wrapperBoundingRect.height,
      width: targetBoundingRect.width,
      visibility: 'visible',
      transitionDuration: newTransitionDuration,
    });
  };

  // When moving the cursor out of the current nav button, either:
  // - slide the highlight box back to the 'active' nav button. (e.g. the 'Market's button if
  //   the user is currently on the /markets page).
  // - hide the highlight box if there is no 'active' nav button.
  const handleMouseOut = () => {
    // Attempt to find an active nav button (if one exists).
    const activeChildIdx = activeChildren.current.findIndex((childActiveStatus) => childActiveStatus);
    // Since none of the nav buttons are active, hide the highlight box.
    const maybeChildRef = activeChildIdx === -1 ? null : childRefs.current[activeChildIdx];

    if (!wrapperRef.current || !maybeChildRef) {
      setHighlightBoxProperties({
        ...highlightBoxProperties,
        visibility: 'hidden',
        transitionDuration: '0s',
      });
      return;
    }

    // Slide the highlight box to the active nav button.
    const targetBoundingRect = maybeChildRef.getBoundingClientRect();
    const wrapperBoundingRect = wrapperRef.current.getBoundingClientRect();
    const newTransitionDuration = highlightBoxProperties.visibility === 'visible' ? '0.2s' : '0s';
    setHighlightBoxProperties({
      left: targetBoundingRect.left - wrapperBoundingRect.left,
      top:
        targetBoundingRect.bottom - wrapperBoundingRect.bottom - targetBoundingRect.height + wrapperBoundingRect.height,
      width: targetBoundingRect.width,
      visibility: 'visible',
      transitionDuration: newTransitionDuration,
    });
  };

  useEffect(() => {
    // Initially after page load,
    // we set the highlight box to the active (child) nav button,
    // if there is one active.
    handleMouseOut();
  }, [location.pathname]);

  // For each child element, attach the following properties
  // so that hovering over them will update the highlight box.
  const newChildren = Children.map(children, (child, i) =>
    cloneElement(child as ReactElement, {
      onMouseOver: handleMouseOver,
      onMouseOut: handleMouseOut,
      style: { zIndex: 10 },
      className: ({ isActive }: { isActive: boolean }) => {
        // This is probably the most hacky part, but additionally
        // update the active children ref here, when the active
        // nav button changes.
        activeChildren.current[i] = isActive;
        return isActive ? 'active' : undefined;
      },
      ref: (el: HTMLAnchorElement) => (childRefs.current[i] = el),
    })
  );
  return (
    <div ref={wrapperRef} className="header-nav-button-wrapper mobile-hide">
      {newChildren}
      {<span className="header-nav-button-highlight" style={highlightBoxProperties} />}
    </div>
  );
};
