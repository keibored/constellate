import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, RoomResult, RoomError } from '../../../shared/presence.js';
import type { TimerAction } from '../../../shared/timer.js';
import { RoomPresence } from './roomPresence.js';
import { RoomTimer } from './roomTimer.js';
import { RoomChat } from './roomChat.js';
import { parseChatSend, parseJoin, parseStatusUpdate, readRoomId } from './validation.js';
import type { RoomRepository } from '../repositories/roomRepository.js';
import { databaseErrorCode } from '../db/pool.js';
import { attachPersistentRoomHandlers } from './persistentRoom.js';
import { RoomNotFoundError } from '../repositories/roomRepository.js';
import type { StudySessionService } from '../services/studySessionService.js';
import type { StatsAccess } from '../services/statsAccess.js';

interface SocketData { membership?: { roomId: string; userId: string } }
type InterServerEvents = Record<string, never>;
const channel = (roomId: string) => `room:${roomId}`;

export function attachRoomSockets(httpServer: HttpServer, allowedOrigins: string[], repository: RoomRepository, graceMs?: number, studies?: StudySessionService, statsAccess?: StatsAccess) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    // CORS applies to polling; also check the origin of WebSocket handshakes.
    allowRequest: (request, callback) => callback(null, !request.headers.origin || allowedOrigins.includes(request.headers.origin)),
    maxHttpBufferSize: 16_384,
  });
  const broadcastMembers = (roomId: string) => {
    studies?.members(roomId, presence.list(roomId));
    io.to(channel(roomId)).emit('presence:list', { roomId, members: presence.list(roomId) });
  };
  const presence = new RoomPresence((roomId, userId) => {
    io.to(channel(roomId)).emit('presence:left', { roomId, userId });
  }, graceMs, broadcastMembers);
  const timers = new RoomTimer(state => io.to(channel(state.roomId)).emit('timer:state', state), event => studies?.timer(event));
  const chat = new RoomChat();

  io.on('connection', socket => {
    let joinGeneration = 0;
    const fail = (message: string, acknowledge?: (result: RoomResult) => void, operation?: RoomError['operation']) => {
      socket.emit('room:error', { message, ...(operation ? { operation } : {}) });
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: message });
    };
    const leaveCurrent = (immediate: boolean) => {
      const current = socket.data.membership;
      if (!current) return;
      statsAccess?.revoke(socket.id);
      socket.leave(channel(current.roomId));
      delete socket.data.membership;
      presence.leave(current.roomId, current.userId, socket.id, immediate);
    };

    socket.on('room:join', async (payload: unknown, acknowledge) => {
      const join = parseJoin(payload);
      if (!join) {
        fail('Use a room ID of 1–64 letters, numbers, hyphens or underscores, a nickname of 1–24 characters, and a valid avatar and user ID.', acknowledge);
        return;
      }
      const generation = ++joinGeneration;
      let saved;
      try { saved = await repository.load(join.roomId, !join.restore); }
      catch (error) {
        const missing = error instanceof RoomNotFoundError;
        if (!missing) console.error(`[database] Room join failed (${databaseErrorCode(error)}).`);
        if (socket.connected && generation === joinGeneration) {
          const message = missing ? error.message : 'Cannot load the saved room yet. Retrying while PostgreSQL recovers…';
          socket.emit('room:error', { message });
          if (typeof acknowledge === 'function') acknowledge({ ok: false, error: message, ...(missing ? { code: 'ROOM_NOT_FOUND' as const } : { retryable: true }) });
        }
        return;
      }
      // An old query must not resurrect presence after leave, disconnect or navigation.
      if (!socket.connected || generation !== joinGeneration) {
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'This room join was superseded.' });
        return;
      }
      const current = socket.data.membership;
      if (current && (current.roomId !== join.roomId || current.userId !== join.user.id)) leaveCurrent(true);

      // The default in-memory adapter joins synchronously. No async room work here.
      socket.join(channel(join.roomId));
      socket.data.membership = { roomId: join.roomId, userId: join.user.id };
      const { member, changed, joined } = presence.join(join.roomId, join.user, socket.id, join.status);
      if (changed) broadcastMembers(join.roomId);
      else socket.emit('presence:list', { roomId: join.roomId, members: presence.list(join.roomId) });
      socket.emit('timer:state', timers.current(join.roomId));
      socket.emit('chat:history', { roomId: join.roomId, messages: chat.history(join.roomId) });
      socket.emit('room:state', saved);
      if (joined) socket.to(channel(join.roomId)).emit('presence:joined', { roomId: join.roomId, member });
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });

    socket.on('room:leave', (payload: unknown, acknowledge) => {
      const roomId = readRoomId(payload);
      if (!roomId) { fail('A valid room ID is required to leave a room.', acknowledge); return; }
      joinGeneration++;
      if (socket.data.membership?.roomId === roomId) leaveCurrent(true);
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });

    socket.on('status:update', (payload: unknown, acknowledge) => {
      const update = parseStatusUpdate(payload);
      if (!update) { fail('Choose coding, reading, writing, studying, break, or dying for a valid room and user.', acknowledge, 'status:update'); return; }
      const current = socket.data.membership;
      if (current?.roomId !== update.roomId || current.userId !== update.userId) {
        fail('You can only change your own status in the room you joined.', acknowledge, 'status:update');
        return;
      }
      const member = presence.updateStatus(update.roomId, update.userId, socket.id, update.status);
      if (!member) { fail('Rejoin the room before changing your status.', acknowledge, 'status:update'); return; }
      // Include the sender and their other tabs so every view uses server state.
      io.to(channel(update.roomId)).emit('presence:updated', { roomId: update.roomId, member });
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });

    socket.on('stats:access', async (payload: unknown, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const roomId = readRoomId(payload);
      const current = socket.data.membership;
      if (!roomId || current?.roomId !== roomId || !presence.hasSocket(roomId, current.userId, socket.id) || !studies || !statsAccess) {
        acknowledge({ ok: false, error: 'Join this room to view study statistics.' }); return;
      }
      try {
        studies.checkpoint();
        await studies.flush();
        if (!socket.connected || socket.data.membership !== current) return;
        acknowledge({ ok: true, token: statsAccess.grant(socket.id, roomId, current.userId) });
      } catch { acknowledge({ ok: false, error: 'Study history is temporarily unavailable. Try again.' }); }
    });

    for (const action of ['start', 'pause', 'resume', 'reset', 'sync'] as const satisfies readonly TimerAction[]) {
      socket.on(`timer:${action}`, (payload: unknown, acknowledge) => {
        const roomId = readRoomId(payload);
        if (!roomId) { fail('A valid room ID is required for the timer.', acknowledge, `timer:${action}`); return; }
        const current = socket.data.membership;
        if (current?.roomId !== roomId || !presence.hasSocket(roomId, current.userId, socket.id)) {
          fail('Join this room before controlling its timer.', acknowledge, `timer:${action}`);
          return;
        }
        const result = timers.apply(roomId, action);
        // Changes are broadcast once by RoomTimer; sync/no-op replies go only to the requester.
        if (!result.changed) socket.emit('timer:state', result.state);
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
      });
    }

    socket.on('chat:send', (payload: unknown, acknowledge) => {
      const message = parseChatSend(payload);
      if (!message) { fail('Enter a message of 1–500 characters for a valid room.', acknowledge, 'chat:send'); return; }
      const current = socket.data.membership;
      const sender = current?.roomId === message.roomId
        ? presence.memberForSocket(message.roomId, current.userId, socket.id) : null;
      if (!sender) { fail('Join this room before sending a message.', acknowledge, 'chat:send'); return; }
      // Only the joined server-side member supplies userId, nickname and avatar.
      const result = chat.send(message.roomId, sender, message.content);
      if (!result.ok) { fail(result.error, acknowledge, 'chat:send'); return; }
      io.to(channel(message.roomId)).emit('chat:message', result.message);
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });

    attachPersistentRoomHandlers(socket, repository, roomId => {
      const current = socket.data.membership;
      const member = current?.roomId === roomId ? presence.memberForSocket(roomId, current.userId, socket.id) : null;
      return member ? { id: member.userId, nickname: member.nickname, avatar: member.avatar } : null;
    }, state => io.to(channel(state.roomId)).emit('room:state', state), studies);

    socket.on('disconnect', () => { joinGeneration++; leaveCurrent(false); });
  });

  httpServer.on('close', () => {
    void studies?.close().catch(error => console.error(`[study] Final checkpoint failed (${databaseErrorCode(error)}).`));
    presence.dispose(); timers.dispose(); chat.dispose();
  });
  return { io, presence, timers, chat };
}
