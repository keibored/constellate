import { readFileSync } from 'node:fs';

const expectedBackend = 'https://constellate-api.onrender.com';

function productionEnvFile() {
  try {
    const text = readFileSync(new URL('../client/.env.production', import.meta.url), 'utf8');
    return Object.fromEntries(text.split(/\r?\n/).flatMap(entry => {
      const line = entry.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) return [];
      const split = line.indexOf('=');
      return [[line.slice(0, split), line.slice(split + 1).trim()]];
    }));
  } catch {
    return {};
  }
}

const file = productionEnvFile();
const raw = process.env.VITE_SERVER_URL?.trim() || file.VITE_SERVER_URL;
const sameOrigin = process.env.VITE_SAME_ORIGIN_BACKEND?.trim() || file.VITE_SAME_ORIGIN_BACKEND;
let url;
try { url = raw ? new URL(raw) : null; } catch { /* handled below */ }

if (!url || url.protocol !== 'https:' || url.origin !== raw
  || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  || raw !== expectedBackend || sameOrigin !== 'true') {
  console.error(`Vercel requires VITE_SERVER_URL=${expectedBackend} and VITE_SAME_ORIGIN_BACKEND=true so browsers use the checked reverse proxy.`);
  process.exitCode = 1;
}
