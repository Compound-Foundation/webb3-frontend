import { useEffect, useState } from 'react';

export function useLocalStorage<T>(storageKey: string, defaultValue: T): [T, (value: T) => void] {
  const parse = (stored: string | null): T => {
    try {
      return JSON.parse(stored ?? 'null') ?? defaultValue;
    } catch {
      return defaultValue;
    }
  };

  // A browser that blocks storage throws on any access
  const [value, setValue] = useState<T>(() => {
    try {
      return parse(window.localStorage.getItem(storageKey));
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setValue(parse(event.newValue));
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  return [
    value,
    (newValue) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(newValue));
      } catch {
        // The value still applies until the page reloads
      }
      setValue(newValue);
    },
  ];
}
