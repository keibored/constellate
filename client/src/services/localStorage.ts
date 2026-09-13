// Browsers may block storage. Keep this tab usable without claiming persistence.
const fallback = new Map<string, string>();
export const guestStorage = {
  get(key: string): string | null {
    try {
      const value = localStorage.getItem(key);
      if (value === null) fallback.delete(key); else fallback.set(key, value);
      return value;
    } catch { return fallback.get(key) ?? null; }
  },
  set(key: string, value: string) {
    fallback.set(key, value);
    try { localStorage.setItem(key, value); } catch { /* Tab-only fallback. */ }
  },
  remove(key: string) {
    fallback.delete(key);
    try { localStorage.removeItem(key); } catch { /* Tab-only fallback. */ }
  },
};
