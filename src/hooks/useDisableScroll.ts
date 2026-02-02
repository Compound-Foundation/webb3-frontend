import { useLayoutEffect } from 'react';

export default function useDisableScroll(disable: boolean) {
  useLayoutEffect(() => {
    if (disable) {
      document.body.classList.add('no-scroll');
    } else {
      document.body.classList.remove('no-scroll');
    }
    return () => {
      document.body.classList.remove('no-scroll');
    };
  }, [disable]);
}
