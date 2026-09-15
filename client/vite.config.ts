import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from '../server/src/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'SERVER_PROXY_TARGET');
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
