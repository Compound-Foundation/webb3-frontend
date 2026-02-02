import { useMemo, useState } from 'react';

export enum Theme {
  Dark = 'Dark',
  Light = 'Light',
}

const THEME_LOCALSTORAGE_KEY = 'webb3-theme';

type ThemeManager = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

export function useThemeManager(): ThemeManager {
  const maybeThemeInStorage: string | null = window.localStorage.getItem(THEME_LOCALSTORAGE_KEY);
  const initialTheme: Theme = maybeThemeInStorage === null ? Theme.Dark : (maybeThemeInStorage as Theme);
  const [theme, setThemeInternal] = useState<Theme>(initialTheme);

  const setTheme = (newTheme: Theme) => {
    window.localStorage.setItem(THEME_LOCALSTORAGE_KEY, newTheme);
    setThemeInternal(newTheme);
  };

  return useMemo(
    () => ({
      theme,
      setTheme,
    }),
    [theme]
  );
}
