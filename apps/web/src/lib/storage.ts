// Per-browser conveniences (open tabs, folders, limit). Storage can be blocked
// or empty; the app works without it.

const prefix = 'altivola-db.'

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(prefix + key)
      return v === null ? fallback : (JSON.parse(v) as T)
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(prefix + key, JSON.stringify(value))
    } catch {
      // storage unavailable
    }
  },
}
