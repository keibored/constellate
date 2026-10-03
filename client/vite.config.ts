import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { parseServerUrl } from './src/services/serverUrl';

export default defineConfig(async ({ mode, command }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), ['SERVER_PROXY_TARGET', 'VITE_']);
  if (command === 'build') {
    parseServerUrl(env.VITE_SERVER_URL, true);
    return {
      plugins: [react()],
      build: {
        sourcemap: false,
        rollupOptions: {
          output: {
            manualChunks(id: string) {
              if (id.includes('@supabase')) return 'supabase';
              if (id.includes('@vercel/analytics')) return 'analytics';
              if (id.includes('socket.io-client') || id.includes('engine.io-client')) return 'realtime';
              if (id.includes('lucide-react')) return 'icons';
              if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
            },
          },
        },
      },
    };
  }
  // The production build has no dependency on server files or the Vite proxy.
  const { loadServerConfig } = await import('../server/src/config');
  const target = env.SERVER_PROXY_TARGET?.trim() || `http://127.0.0.1:${loadServerConfig().port}`;
  return {
    plugins: [react()],
    server: {
      port: 5173, strictPort: true,
      proxy: {
        '/socket.io': { target, ws: true },
        '/api': { target },
      },
    },
  };
});
