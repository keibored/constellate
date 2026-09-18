import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/presence';
import { serverUrl } from './api';

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// One socket per browser tab. The presence hook owns its connection and listeners.
export const roomSocket: RoomSocket = io(serverUrl || undefined, {
  // A single WebSocket does not require load-balancer session affinity.
  ...(import.meta.env.PROD ? { transports: ['websocket'] } : {}),
  autoConnect: false,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 5_000,
  timeout: 10_000,
  closeOnBeforeunload: true,
});

export function logRoomEvent(event: string, details?: unknown) {
  if (import.meta.env.DEV) console.info(`[Constellate] ${event}`, details ?? '');
}

if (import.meta.hot) import.meta.hot.dispose(() => roomSocket.disconnect());
