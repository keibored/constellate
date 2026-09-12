import type { RoomError, RoomUser } from '../../../shared/presence';
import type { RoomSocket } from './socket';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
const JOIN_ATTEMPTS = 3;

interface RoomConnectionHandlers {
  connection: (status: ConnectionStatus) => void;
  error: (message: string | null) => void;
  disconnected: () => void;
  log?: (event: string, details?: unknown) => void;
}

/** Owns one room subscription. Retries joins on the existing transport, with a limit. */
export function connectRoom(socket: RoomSocket, roomId: string, user: RoomUser, handlers: RoomConnectionHandlers) {
  let active = true;
  let generation = 0;
  let joinAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const log = handlers.log ?? (() => {});
  const cancelJoin = () => {
    generation++;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const fail = (message: string) => {
    handlers.error(message);
    handlers.connection('error');
  };
  const join = () => {
    if (!active || !socket.connected) return;
    const request = ++generation;
    joinAttempts++;
    handlers.connection(joinAttempts === 1 ? 'connecting' : 'reconnecting');
    handlers.error(null);
    socket.timeout(5_000).emit('room:join', { roomId, user }, (timeoutError: Error | null, result) => {
      if (!active || request !== generation || !socket.connected) return;
      if (timeoutError) {
        log('room error', { roomId, message: 'Join acknowledgement timed out', attempt: joinAttempts });
        if (joinAttempts < JOIN_ATTEMPTS) {
          handlers.connection('reconnecting');
          retryTimer = setTimeout(join, joinAttempts * 1_000);
        } else fail('The room did not respond. Try reconnecting.');
      } else if (!result?.ok) {
        log('room error', { roomId, message: result?.error });
        fail(result?.error ?? 'Unable to join this room.');
      } else {
        handlers.connection('connected');
        handlers.error(null);
        log('joined room', { roomId, userId: user.id, socketId: socket.id });
      }
    });
  };
  const onConnect = () => {
    cancelJoin();
    joinAttempts = 0;
    log('connected', { socketId: socket.id });
    join();
  };
  const onDisconnect = (reason: string) => {
    cancelJoin();
    handlers.disconnected();
    log('disconnected', { roomId, reason });
    if (reason === 'io server disconnect') fail('The room disconnected. Try reconnecting.');
    else handlers.connection('reconnecting');
  };
  const onConnectError = (error: Error) => {
    log('room error', { roomId, message: error.message });
    if (socket.active) {
      handlers.connection('reconnecting');
      handlers.error('Cannot reach the room yet. Retrying automatically…');
    } else fail('Cannot connect to the room. Try reconnecting.');
  };
  const onReconnecting = (attempt: number) => {
    handlers.connection('reconnecting');
    log('reconnecting', { roomId, attempt });
  };
  const onReconnectFailed = () => fail('Cannot reach the room. Try reconnecting.');
  const onRoomError = ({ message, operation }: RoomError) => {
    log('room error', { roomId, message, operation });
    if (!operation) fail(message);
  };

  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('connect_error', onConnectError);
  socket.on('room:error', onRoomError);
  socket.io.on('reconnect_attempt', onReconnecting);
  socket.io.on('reconnect_failed', onReconnectFailed);
  handlers.connection('connecting');
  if (socket.connected) onConnect();
  else socket.connect();

  return {
    retry() {
      if (!active) return;
      cancelJoin();
      joinAttempts = 0;
      handlers.error(null);
      handlers.connection('connecting');
      if (socket.connected) join();
      else socket.connect();
    },
    dispose() {
      if (!active) return;
      active = false;
      cancelJoin();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:error', onRoomError);
      socket.io.off('reconnect_attempt', onReconnecting);
      socket.io.off('reconnect_failed', onReconnectFailed);
      // Explicit navigation leaves immediately, even if its join ack was lost.
      // Browser unload closes the transport instead, preserving the server grace period.
      if (socket.connected) socket.emit('room:leave', { roomId }, () => {});
      socket.disconnect();
    },
  };
}
