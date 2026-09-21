/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_SAME_ORIGIN_BACKEND?: string;
  readonly VITE_ICE_SERVERS?: string;
}
