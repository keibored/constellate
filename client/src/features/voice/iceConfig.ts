/** ICE credentials are necessarily visible to the browser. Use short-lived TURN credentials in a future deployment. */
export function parseIceServers(raw?: string): RTCIceServer[] {
  if (!raw?.trim()) return [{ urls: 'stun:stun.l.google.com:19302' }];
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new Error('Voice network configuration is invalid. Check VITE_ICE_SERVERS.'); }
  if (!Array.isArray(values) || values.length > 8) throw new Error('Voice network configuration must be an ICE server list.');
  return values.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid ICE server.');
    const urls = typeof value.urls === 'string' ? [value.urls] : value.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || url.length > 500 || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))
      || (value.username !== undefined && typeof value.username !== 'string') || (value.credential !== undefined && typeof value.credential !== 'string')) throw new Error('Invalid ICE server configuration.');
    return { urls, ...(value.username !== undefined ? { username: value.username } : {}), ...(value.credential !== undefined ? { credential: value.credential } : {}) };
  });
}
export const voiceIceServers = () => parseIceServers(import.meta.env.VITE_ICE_SERVERS);
