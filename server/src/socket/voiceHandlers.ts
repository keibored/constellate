import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, RoomResult } from '../../../shared/presence.js';
import type { VoiceSignal, VoiceSignalEvent, VoiceSignalRequest } from '../../../shared/voice.js';
import type { RedisRoomRuntime } from '../redis/roomRuntime.js';
import { voiceParticipants } from '../redis/roomState.js';
import { readRoomId } from './validation.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const shortString = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
export function parseVoiceSignal(event: VoiceSignalEvent, value: unknown): VoiceSignalRequest | null {
  if (!record(value) || !readRoomId(value) || !uuid(value.sessionId) || !uuid(value.targetSessionId) || !uuid(value.negotiationId)
    || typeof value.targetGuestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.targetGuestId)) return null;
  const base = { roomId: value.roomId as string, sessionId: value.sessionId, targetGuestId: value.targetGuestId, targetSessionId: value.targetSessionId, negotiationId: value.negotiationId };
  if (event === 'voice:restart') return base;
  if (event === 'voice:offer' || event === 'voice:answer') {
    const description = value.description;
    if (!record(description) || description.type !== (event === 'voice:offer' ? 'offer' : 'answer') || typeof description.sdp !== 'string'
      || description.sdp.length < 1 || description.sdp.length > 12_000 || /(?:^|\r?\n)m=(?:video|application)\s/.test(description.sdp)) return null;
    return { ...base, description: { type: event === 'voice:offer' ? 'offer' : 'answer', sdp: description.sdp } };
  }
  const candidate = value.candidate;
  if (!record(candidate) || !shortString(candidate.candidate, 2048) || (candidate.sdpMid !== null && !shortString(candidate.sdpMid, 64))
    || (candidate.sdpMLineIndex !== null && (!Number.isInteger(candidate.sdpMLineIndex) || Number(candidate.sdpMLineIndex) < 0 || Number(candidate.sdpMLineIndex) > 16))
    || (candidate.usernameFragment !== undefined && candidate.usernameFragment !== null && !shortString(candidate.usernameFragment, 256))) return null;
  return { ...base, candidate: { candidate: candidate.candidate as string, sdpMid: candidate.sdpMid as string | null,
    sdpMLineIndex: candidate.sdpMLineIndex as number | null, ...(candidate.usernameFragment !== undefined ? { usernameFragment: candidate.usernameFragment as string | null } : {}) } };
}

export function attachVoiceHandlers(socket: Socket<ClientToServerEvents, ServerToClientEvents>, runtime: RedisRoomRuntime,
  membership: () => { roomId: string; userId: string } | undefined,
  relay: (socketId: string, event: VoiceSignalEvent, signal: VoiceSignal) => void,
  schedule: (work: () => Promise<void>) => void) {
  const unavailable: RoomResult = { ok: false, error: 'Voice signaling is unavailable. The room can reconnect and try again.' };
  const current = (value: unknown) => {
    const roomId = readRoomId(value), member = membership();
    return roomId && member?.roomId === roomId ? member : null;
  };
  // Share the room lifecycle queue: a slow join must not commit after its cancel/leave.
  socket.on('voice:join', (payload: unknown, acknowledge) => schedule(async () => {
    if (typeof acknowledge !== 'function') return;
    const member = current(payload);
    if (!member || !record(payload) || !uuid(payload.clientId) || typeof payload.muted !== 'boolean') { acknowledge({ ok: false, error: 'Join this study room before joining voice.' }); return; }
    try {
      const result = await runtime.act(member.roomId, { kind: 'voiceJoin', guestId: member.userId, socketId: socket.id, clientId: payload.clientId, muted: payload.muted });
      if (result.error) { acknowledge({ ok: false, error: result.error }); return; }
      if (!socket.connected || membership() !== member) {
        await runtime.act(member.roomId, { kind: 'voiceLeave', guestId: member.userId, socketId: socket.id, clientId: payload.clientId }); return;
      }
      acknowledge({ ok: true, sessionId: result.room.voice[member.userId].sessionId, participants: voiceParticipants(result.room) });
    } catch { acknowledge(unavailable); }
  }));
  socket.on('voice:leave', (payload: unknown, acknowledge) => schedule(async () => {
    if (typeof acknowledge !== 'function') return;
    const member = current(payload);
    if (!member || !record(payload) || !uuid(payload.clientId)) { acknowledge({ ok: false, error: 'A valid room and voice session are required.' }); return; }
    try { await runtime.act(member.roomId, { kind: 'voiceLeave', guestId: member.userId, socketId: socket.id, clientId: payload.clientId }); acknowledge({ ok: true }); }
    catch { acknowledge(unavailable); }
  }));
  socket.on('voice:mute-state', (payload: unknown, acknowledge) => schedule(async () => {
    if (typeof acknowledge !== 'function') return;
    const member = current(payload);
    if (!member || !record(payload) || !uuid(payload.sessionId) || typeof payload.muted !== 'boolean') { acknowledge({ ok: false, error: 'Join voice in this tab before changing mute.' }); return; }
    try {
      const result = await runtime.act(member.roomId, { kind: 'voiceMute', guestId: member.userId, socketId: socket.id, sessionId: payload.sessionId, muted: payload.muted });
      acknowledge(result.error ? { ok: false, error: result.error } : { ok: true });
    } catch { acknowledge(unavailable); }
  }));
  // Signaling has one socket owner, so this process-local rate window cannot
  // be multiplied by the guest's other tabs. No SDP/candidate is stored.
  let windowStarted = 0, sent = 0;
  for (const event of ['voice:offer', 'voice:answer', 'voice:ice-candidate', 'voice:restart'] as const) socket.on(event, async (payload: unknown, acknowledge) => {
    if (typeof acknowledge !== 'function') return;
    const member = current(payload), signal = parseVoiceSignal(event, payload);
    if (!member || !signal) { acknowledge({ ok: false, error: 'Invalid voice signal for this room.' }); return; }
    if (Date.now() - windowStarted >= 3000) { windowStarted = Date.now(); sent = 0; }
    if (++sent > 100) { acknowledge({ ok: false, error: 'Voice is reconnecting too quickly. Wait a moment.' }); return; }
    try {
      const target = await runtime.voiceTarget(member.userId, socket.id, signal);
      if (!target || !socket.connected || membership() !== member) { acknowledge({ ok: false, error: 'That voice connection has ended. Rejoin voice if needed.' }); return; }
      relay(target, event, { roomId: member.roomId, fromGuestId: member.userId, fromSessionId: signal.sessionId,
        toSessionId: signal.targetSessionId, negotiationId: signal.negotiationId,
        ...(signal.description ? { description: signal.description } : {}), ...(signal.candidate ? { candidate: signal.candidate } : {}) });
      acknowledge({ ok: true });
    } catch { acknowledge(unavailable); }
  });
}
