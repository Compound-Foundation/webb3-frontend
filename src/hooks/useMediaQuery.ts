import { useCallback, useSyncExternalStore } from 'react';

/**
 * A custom React hook that monitors a given CSS media query and updates its state when the query state changes.
 *
 * @param query - The CSS media query string used to evaluate the media condition.
 * @returns - A boolean value indicating whether the media query matches the current state of the viewport or device.
 *
 * Example usage:
 * const isLarge = useMediaQuery('(min-width: 1024px)')
 */
export const useMediaQuery = (query: string): boolean => {
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  const subscribe = useCallback(
    (callback: () => void) => {
      const mediaQueryList = window.matchMedia(query);
      mediaQueryList.addEventListener('change', callback);
      return () => mediaQueryList.removeEventListener('change', callback);
    },
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
};