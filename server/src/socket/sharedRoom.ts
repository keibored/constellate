import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ClientToServerEvents, ServerToClientEvents, RoomResult, RoomError } from '../../../shared/presence.js';
import { parseChatSend, parseJoin, parseStatusUpdate, readRoomId } from './validation.js';
import { RoomNotFoundError, type RoomRepository } from '../repositories/roomRepository.js';
import { attachPersistentRoomHandlers } from './persistentRoom.js';
import { RedisRoomRuntime } from '../redis/roomRuntime.js';
import { RedisStatsAccess } from '../redis/statsAccess.js';
import { members, timerSnapshot, voiceParticipants, type RuntimeAction } from '../redis/roomState.js';
import { attachVoiceHandlers } from './voiceHandlers.js';
import { RuntimeUnavailableError } from '../redis/connection.js';
import { databaseErrorCode } from '../db/pool.js';
import { log } from '../logger.js';
import { RedisRateLimiter, requestRateKey } from '../security/rateLimit.js';
import { createHash } from 'node:crypto';
import type { OwnedRoomRepository } from '../repositories/roomRepository.js';
import type { AccountVerifier } from '../services/supabaseAuth.js';

interface SocketData { membership?: { roomId: string; userId: string }; statsToken?: string; clientKey?: string }
const channel = (roomId: string) => `room:${roomId}`;

export function attachSharedRoomSockets(httpServer: HttpServer, allowedOrigins: string[], repository: RoomRepository, runtime: RedisRoomRuntime, access: RedisStatsAccess, options: { production?: boolean; trustProxy?: number; accountVerifier?: AccountVerifier } = {}) {
  let draining = false;
  const rateLimiter = new RedisRateLimiter(runtime.redis);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    allowRequest: (request, callback) => {
      if (draining || !runtime.redis.ready || (request.headers.origin && !allowedOrigins.includes(request.headers.origin))) {
        callback(null, false); return;
      }
      const clientKey = requestRateKey(request, options.trustProxy ?? 0);
      void rateLimiter.allow('handshake', clientKey, 60, 60_000)
        .then(allowed => callback(null, allowed && !draining && runtime.redis.ready))
        .catch(() => callback(null, false));
    },
    ...(options.production ? { transports: ['polling' as const, 'websocket' as const] } : {}),
    pingInterval: 25000,
    pingTimeout: 20000,
    perMessageDeflate: false,
    maxHttpBufferSize: 16_384,
  });
  io.adapter(createAdapter(runtime.redis.publisher, runtime.redis.subscriber, { key: runtime.redis.keys.adapter, publishOnSpecificResponseChannel: true }));
  const jobs = new Set<Promise<void>>();
  runtime.onExpiredSocket = socketId => io.sockets.sockets.get(socketId)?.conn.close();
  runtime.onChange = (result, now) => {
    const room = result.room;
    if (result.presenceChanged) io.to(channel(room.roomId)).emit('presence:list', { roomId: room.roomId, members: members(room), epoch: room.epoch, revision: room.revision });
    if (result.timerChanged) io.to(channel(room.roomId)).emit('timer:state', timerSnapshot(room, now));
    if (result.message) io.to(channel(room.roomId)).emit('chat:message', result.message);
    if (result.reaction) io.to(channel(room.roomId)).emit('reaction:new', result.reaction);
    if (result.voiceChanged) io.to(channel(room.roomId)).emit('voice:participants', voiceParticipants(room));
  };
  runtime.redis.onAvailability = ready => {
    if (!ready) {
      for (const socket of io.sockets.sockets.values()) {
        socket.emit('room:error', { message: 'The realtime state service is unavailable. Reconnecting…' });
        socket.conn.close(); // Transport close preserves the client's normal retry behavior.
      }
    } else void runtime.sweep().catch(() => {});
  };
  io.on('connection', socket => {
    socket.data.clientKey = requestRateKey(socket.request, options.trustProxy ?? 0);
    let queue = Promise.resolve();
    let pending = 0;
    const schedule = (work: () => Promise<void>, acknowledge?: (result: RoomResult) => void, operation?: RoomError['operation']) => {
      // Disconnected sockets must still enqueue their cleanup while draining.
      if (socket.connected && (draining || pending >= 64)) { socket.conn.close(); return; }
      pending++;
      const job = queue.then(work).catch(error => {
        const missing = error instanceof RoomNotFoundError;
        if (!missing) log('warn', 'socket.operation_failed', 'Shared room operation failed.', { code: databaseErrorCode(error), operation });
        const message = missing ? error.message : error instanceof RuntimeUnavailableError ? error.message : 'Shared room state is temporarily unavailable. Please reconnect and try again.';
        if (socket.connected) socket.emit('room:error', { message, ...(operation ? { operation } : {}) });
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: message, ...(missing ? { code: 'ROOM_NOT_FOUND' as const } : { retryable: true }) });
      });
      queue = job; jobs.add(job); void job.finally(() => { jobs.delete(job); pending--; });
    };
    const fail = (message: string, acknowledge?: (result: RoomResult) => void, operation?: RoomError['operation']) => {
      if (socket.connected) socket.emit('room:error', { message, ...(operation ? { operation } : {}) });
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: message });
    };
    const leave = async (immediate: boolean) => {
      runtime.detachSocket(socket.id);
      const current = socket.data.membership;
      delete socket.data.membership;
      await access.revoke(socket.data.statsToken); delete socket.data.statsToken;
      if (!current) return;
      await socket.leave(channel(current.roomId));
      await runtime.act(current.roomId, { kind: 'leave', guestId: current.userId, socketId: socket.id, immediate });
    };
    const perform = async (roomId: string, action: RuntimeAction, acknowledge?: (result: RoomResult) => void, operation?: RoomError['operation']) => {
      if (socket.data.membership?.roomId !== roomId) { fail('Join this room before changing its state.', acknowledge, operation); return; }
      const result = await runtime.act(roomId, action);
      if (result.error) { fail(result.error, acknowledge, operation); return; }
      if (action.kind === 'timer' && !result.timerChanged) socket.emit('timer:state', timerSnapshot(result.room, result.now));
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    };
    socket.on('room:join', (payload: unknown, acknowledge) => {
      const join = parseJoin(payload);
      if (!join) { fail('Use a valid room, guest ID, nickname and avatar.', acknowledge); return; }
      schedule(async () => {
        if (!socket.connected) return;
        runtime.redis.requireReady();
        const accessRepository = repository as RoomRepository & Partial<OwnedRoomRepository>;
        const roomAccess = accessRepository.roomAccess ? await accessRepository.roomAccess(join.roomId) : null;
        if (roomAccess?.visibility === 'private') {
          const raw = payload as { accountToken?: unknown; inviteToken?: unknown };
          const account = typeof raw.accountToken === 'string' && options.accountVerifier
            ? await options.accountVerifier.verify(raw.accountToken) : null;
          const inviteHash = typeof raw.inviteToken === 'string' && raw.inviteToken.length <= 256
            ? createHash('sha256').update(raw.inviteToken).digest('hex') : null;
          const allowed = account?.id === roomAccess.ownerUserId
            || Boolean(inviteHash && roomAccess.inviteTokenHash === inviteHash);
          if (!allowed) {
            if (typeof acknowledge === 'function') acknowledge({ ok: false, code: 'ROOM_FORBIDDEN', error: 'This room is private. Ask its owner for a new invitation link.' });
            return;
          }
        }
        const clientKey = socket.data.clientKey!;
        if (!await rateLimiter.allow('room-join', clientKey, 30, 60_000)) {
          fail('Too many room changes. Wait a minute and try again.', acknowledge); return;
        }
        const missing = !join.restore && (!repository.exists || !await repository.exists(join.roomId));
        if (missing && !await rateLimiter.allow('room-create', clientKey, 10, 60 * 60_000)) {
          fail('Too many new rooms from this network. Try again later.', acknowledge); return;
        }
        await repository.load(join.roomId, !join.restore);
        if (!socket.connected) return;
        const current = socket.data.membership;
        if (current && (current.roomId !== join.roomId || current.userId !== join.user.id)) await leave(true);
        // Subscribe before loading snapshots; revisions reject an older direct
        // reply if another node broadcasts a newer update during this join.
        await socket.join(channel(join.roomId));
        let saved, result;
        try {
          saved = await repository.load(join.roomId, false);
          result = await runtime.act(join.roomId, { kind: 'join', user: join.user, socketId: socket.id, owner: runtime.owner, status: join.status });
        } catch (error) { await socket.leave(channel(join.roomId)); throw error; }
        if (!socket.connected) { await runtime.act(join.roomId, { kind: 'leave', guestId: join.user.id, socketId: socket.id, immediate: false }); return; }
        socket.data.membership = { roomId: join.roomId, userId: join.user.id };
        socket.emit('presence:list', { roomId: join.roomId, members: members(result.room), epoch: result.room.epoch, revision: result.room.revision });
        socket.emit('timer:state', timerSnapshot(result.room, result.now));
        socket.emit('chat:history', { roomId: join.roomId, messages: result.room.messages });
        socket.emit('reaction:history', { roomId: join.roomId, reactions: result.room.reactions });
        socket.emit('voice:participants', voiceParticipants(result.room));
        socket.emit('room:state', saved);
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
      }, acknowledge);
    });
    socket.on('room:leave', (payload: unknown, acknowledge) => {
      const roomId = readRoomId(payload);
      if (!roomId) { fail('A valid room ID is required.', acknowledge); return; }
      schedule(async () => { if (socket.data.membership?.roomId === roomId) await leave(true); if (typeof acknowledge === 'function') acknowledge({ ok: true }); }, acknowledge);
    });
    socket.on('status:update', (payload: unknown, acknowledge) => {
      const update = parseStatusUpdate(payload);
      if (!update || socket.data.membership?.userId !== update.userId) { fail('Choose your own status in the joined room.', acknowledge, 'status:update'); return; }
      schedule(() => perform(update.roomId, { kind: 'status', guestId: update.userId, socketId: socket.id, status: update.status }, acknowledge, 'status:update'), acknowledge, 'status:update');
    });
    for (const action of ['start', 'pause', 'resume', 'reset', 'sync'] as const) socket.on(`timer:${action}`, (payload: unknown, acknowledge) => {
      const roomId = readRoomId(payload);
      if (!roomId) { fail('A valid room ID is required.', acknowledge, `timer:${action}`); return; }
      schedule(() => perform(roomId, { kind: 'timer', guestId: socket.data.membership?.userId ?? '', socketId: socket.id, action }, acknowledge, `timer:${action}`), acknowledge, `timer:${action}`);
    });
    socket.on('chat:send', (payload: unknown, acknowledge) => {
      const message = parseChatSend(payload);
      if (!message) { fail('Enter a message of 1–500 characters for a valid room.', acknowledge, 'chat:send'); return; }
      schedule(() => perform(message.roomId, { kind: 'chat', guestId: socket.data.membership?.userId ?? '', socketId: socket.id, content: message.content }, acknowledge, 'chat:send'), acknowledge, 'chat:send');
    });
    socket.on('reaction:send', (payload: unknown, acknowledge) => {
      const roomId = readRoomId(payload);
      const kind = (payload as { kind?: unknown } | null)?.kind;
      if (!roomId || (kind !== 'coffee' && kind !== 'sparkle' && kind !== 'heart' && kind !== 'cry')) { fail('Choose a valid reaction for this room.', acknowledge, 'reaction:send'); return; }
      schedule(() => perform(roomId, { kind: 'reaction', guestId: socket.data.membership?.userId ?? '', socketId: socket.id, reaction: kind }, acknowledge, 'reaction:send'), acknowledge, 'reaction:send');
    });
    socket.on('stats:access', (payload: unknown, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const roomId = readRoomId(payload);
      schedule(async () => {
        const current = socket.data.membership;
        if (!roomId || current?.roomId !== roomId || !await runtime.member(roomId, current.userId, socket.id)) { acknowledge({ ok: false, error: 'Join this room to view study statistics.' }); return; }
        await runtime.checkpoint(roomId);
        if (!socket.connected || socket.data.membership !== current) return;
        socket.data.statsToken = await access.grant(socket.id, roomId, current.userId, socket.data.statsToken);
        acknowledge({ ok: true, token: socket.data.statsToken });
      }, result => { if (!result.ok) acknowledge(result); });
    });
    attachPersistentRoomHandlers(socket, repository, async roomId => {
      const current = socket.data.membership;
      if (current?.roomId !== roomId) return null;
      const member = await runtime.member(roomId, current.userId, socket.id);
      return member ? { id: member.userId, nickname: member.nickname, avatar: member.avatar } : null;
    }, state => io.to(channel(state.roomId)).emit('room:state', state), runtime, schedule);
    attachVoiceHandlers(socket, runtime, () => socket.data.membership, (target, event, signal) => io.to(target).emit(event, signal), schedule);
    socket.on('disconnect', () => schedule(() => leave(false)));
  });
  runtime.start();
  return { io, beginDrain: () => { draining = true; }, closeRuntime: async () => {
    while (jobs.size) await Promise.allSettled([...jobs]);
    await runtime.close();
  } };
}
