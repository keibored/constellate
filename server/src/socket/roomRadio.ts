import { randomUUID } from 'node:crypto';
import type { MemberPresence } from '../../../shared/presence.js';
import type { RadioRequest, RadioState, RadioSnapshot } from '../../../shared/radio.js';
import { radioTrack } from '../../../shared/radioCatalog.js';

export const MAX_RADIO_QUEUE = 12;
export const freshRadio = (): RadioState => ({ hostId: null, trackId: 'moonlit-notes', playing: false, positionMs: 0, startedAt: null, queue: [] });
export function radioPosition(state: RadioState, now: number) {
  return state.positionMs + (state.playing && state.startedAt !== null ? Math.max(0, now - state.startedAt) : 0);
}
export function reconcileRadio(state: RadioState, members: MemberPresence[], now: number): boolean {
  let changed = false;
  const connected = members.filter(member => member.connected);
  if (!connected.some(member => member.userId === state.hostId)) {
    const host = connected[0]?.userId ?? null;
    if (host !== state.hostId) { state.hostId = host; changed = true; }
  }
  if (!connected.length && state.playing) {
    state.positionMs = radioPosition(state, now) % radioTrack(state.trackId)!.durationMs;
    state.playing = false; state.startedAt = null; changed = true;
  }
  // Catch up after a sleeping server without drifting the original playback clock.
  while (state.playing && radioPosition(state, now) >= radioTrack(state.trackId)!.durationMs) {
    const remaining = radioPosition(state, now) - radioTrack(state.trackId)!.durationMs;
    const next = state.queue.shift();
    if (next) state.trackId = next.trackId;
    state.positionMs = 0; state.startedAt = now - remaining; changed = true;
    if (!state.queue.length) {
      state.startedAt = now - remaining % radioTrack(state.trackId)!.durationMs;
      break;
    }
  }
  return changed;
}
export function changeRadio(state: RadioState, request: RadioRequest, member: MemberPresence, now: number): string | null {
  if (request.command === 'sync') return null;
  if (request.command === 'suggest') {
    if (!radioTrack(request.trackId)) return 'Choose a track from the room radio library.';
    if (state.queue.length >= MAX_RADIO_QUEUE) return 'The queue is full. Wait for a track to finish.';
    state.queue.push({ id: randomUUID(), trackId: request.trackId!, nickname: member.nickname });
    return null;
  }
  if (member.userId !== state.hostId) return 'Only the radio host can control shared playback.';
  if (request.command === 'remove') {
    const index = state.queue.findIndex(entry => entry.id === request.entryId);
    if (index === -1) return 'That track is no longer in the queue.';
    state.queue.splice(index, 1);
  } else if (request.command === 'select') {
    if (!radioTrack(request.trackId)) return 'Choose a track from the room radio library.';
    state.trackId = request.trackId!; state.positionMs = 0; state.startedAt = state.playing ? now : null;
  } else if (request.command === 'next') {
    state.trackId = state.queue.shift()?.trackId ?? state.trackId;
    state.positionMs = 0; state.startedAt = state.playing ? now : null;
  } else if (request.command === 'play' && !state.playing) {
    state.playing = true; state.startedAt = now;
  } else if (request.command === 'pause' && state.playing) {
    state.positionMs = radioPosition(state, now); state.playing = false; state.startedAt = null;
  }
  return null;
}
export function radioSnapshot(state: RadioState, roomId: string, epoch: string, revision: number, now: number): RadioSnapshot {
  return { ...state, queue: state.queue.map(entry => ({ ...entry })), roomId, epoch, revision, serverNow: now };
}
export function parseRadioRequest(payload: unknown): RadioRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<RadioRequest>;
  if (typeof p.roomId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.roomId)
    || !['play', 'pause', 'next', 'select', 'suggest', 'remove', 'sync'].includes(p.command ?? '')) return null;
  if ((p.command === 'select' || p.command === 'suggest') && !radioTrack(p.trackId)) return null;
  if (p.command === 'remove' && (typeof p.entryId !== 'string' || p.entryId.length > 64)) return null;
  return { roomId: p.roomId, command: p.command!, trackId: p.trackId, entryId: p.entryId };
}
