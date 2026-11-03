import { useLayoutEffect } from 'react';

/** How many mounted components hold the page's scroll lock. */
let lockCount = 0;

/**
 * Stops the page behind a dialog from scrolling while `disable` is true. Each component that passes
 * true holds the lock until it passes false or unmounts. The page scrolls again once no component
 * holds the lock. A component that passes false holds no lock, so it never ends another one's.
 */
export default function useDisableScroll(disable: boolean) {
  useLayoutEffect(() => {
    if (!disable) return;
    lockCount += 1;
    document.body.classList.add('no-scroll');
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.classList.remove('no-scroll');
    };
  }, [disable]);
}
