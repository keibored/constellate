import { readFileSync } from 'node:fs';

function fromProductionEnvFile() {
  try {
    const text = readFileSync(new URL('../client/.env.production', import.meta.url), 'utf8');
    const line = text.split(/\r?\n/).find(entry => entry.trim().startsWith('VITE_SERVER_URL='));
    return line?.slice(line.indexOf('=') + 1).trim();
  } catch {
    return undefined;
  }
}

const raw = process.env.VITE_SERVER_URL?.trim() || fromProductionEnvFile();
let url;
try { url = raw ? new URL(raw) : null; } catch { /* handled below */ }

if (!url || url.protocol !== 'https:' || url.origin !== raw
  || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  console.error('Vercel requires VITE_SERVER_URL to be the exact Render backend HTTPS origin (no trailing slash, path, credentials, query, localhost, or wildcard).');
  process.exitCode = 1;
}
