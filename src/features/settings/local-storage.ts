type PreferenceStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

// Reading `localStorage` throws when the browser blocks storage; tests run without DOM types.
function preferenceStorage(): PreferenceStorage | undefined {
  return (globalThis as typeof globalThis & { localStorage?: PreferenceStorage }).localStorage
}

/** Reads a stored preference, treating unavailable storage as a missing value. */
export function readLocalStorage(key: string): string | null {
  try {
    return preferenceStorage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Stores a preference, or removes it when `value` is null; full or blocked storage only loses persistence. */
export function writeLocalStorage(key: string, value: string | null): void {
  try {
    const storage = preferenceStorage()
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch {
    // The in-memory preference still applies for this page.
  }
}
