import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'theme'
const listeners = new Set<() => void>()

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Storage can be blocked; the theme still applies for this visit.
  }
  for (const l of listeners) l()
}

/** The theme as React state, so every switch (button or ⌘K) updates the icons. */
export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, currentTheme)
}
