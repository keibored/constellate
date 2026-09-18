import { parseServerUrl } from './serverUrl';

export const serverUrl = parseServerUrl(import.meta.env.VITE_SERVER_URL, import.meta.env.PROD);
export const apiUrl = (path: string) => `${serverUrl}${path}`;
