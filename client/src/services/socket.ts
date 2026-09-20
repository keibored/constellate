import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/presence';
import { serverUrl } from './api';

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// One socket per browser tab. The presence hook owns its connection and listeners.
export const roomSocket: RoomSocket = io(serverUrl || undefined, {
  // The single production backend can keep polling sessions on one instance.
  // Polling also works on networks that block WebSocket upgrades.
  ...(import.meta.env.PROD ? { transports: ['polling', 'websocket'], tryAllTransports: true } : {}),
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
