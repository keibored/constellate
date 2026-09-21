import { parseServerUrl } from './serverUrl';

const useSameOriginBackend = import.meta.env.PROD && import.meta.env.VITE_SAME_ORIGIN_BACKEND === 'true';

export const serverUrl = useSameOriginBackend
  ? ''
  : parseServerUrl(import.meta.env.VITE_SERVER_URL, import.meta.env.PROD);
export const apiUrl = (path: string) => `${serverUrl}${path}`;
