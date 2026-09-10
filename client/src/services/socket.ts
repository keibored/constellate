import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/presence';

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// One socket per browser tab. The presence hook owns its connection and listeners.
export const roomSocket: RoomSocket = io(import.meta.env.VITE_SERVER_URL || 'http://localhost:3000', {
  autoConnect: false,
});

if (import.meta.hot) import.meta.hot.dispose(() => roomSocket.disconnect());
