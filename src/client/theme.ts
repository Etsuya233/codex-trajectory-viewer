export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'codex-trajectory:theme';

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function initialTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function applyTheme(theme: Theme) {
  document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

export function rememberTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A blocked storage area only costs the preference, not the current theme.
  }
}
