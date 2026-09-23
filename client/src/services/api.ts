import { parseServerUrl } from './serverUrl';

// `import.meta.env` is injected by Vite and absent in Node unit tests.
const clientEnvironment = import.meta.env;
const production = Boolean(clientEnvironment?.PROD);
const useSameOriginBackend = production && clientEnvironment?.VITE_SAME_ORIGIN_BACKEND === 'true';

export const serverUrl = useSameOriginBackend
  ? ''
  : parseServerUrl(clientEnvironment?.VITE_SERVER_URL, production);
export const apiUrl = (path: string) => `${serverUrl}${path}`;
