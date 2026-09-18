const raw = process.env.VITE_SERVER_URL?.trim();
let url;
try { url = raw ? new URL(raw) : null; } catch { /* handled below */ }

if (!url || url.protocol !== 'https:' || url.origin !== raw
  || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  console.error('Vercel requires VITE_SERVER_URL to be the exact Render backend HTTPS origin (no trailing slash, path, credentials, query, localhost, or wildcard).');
  process.exitCode = 1;
}
