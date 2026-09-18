export function parseServerUrl(raw?: string, production = false): string {
  if (!raw?.trim()) return '';
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('VITE_SERVER_URL must be an HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('VITE_SERVER_URL must be an HTTP(S) origin without credentials, path or query.');
  }
  if (production && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Production VITE_SERVER_URL must use a non-loopback HTTPS origin, or be blank for same-origin hosting.');
  }
  return url.origin;
}
