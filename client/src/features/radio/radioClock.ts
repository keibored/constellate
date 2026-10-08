import type { RadioSnapshot } from '../../../../shared/radio';
import { radioTrack } from '../../../../shared/radioCatalog.js';

export interface ReceivedRadio { state: RadioSnapshot; receivedAt: number; socketId: string }
export function receiveRadio(previous: ReceivedRadio | null, state: RadioSnapshot, receivedAt: number, socketId: string): ReceivedRadio {
  if (previous?.socketId === socketId && previous.state.epoch === state.epoch
    && (state.revision < previous.state.revision || (state.revision === previous.state.revision && state.serverNow <= previous.state.serverNow))) return previous;
  return { state, receivedAt, socketId };
}
export function radioElapsed(received: ReceivedRadio | null, now: number): number {
  if (!received) return 0;
  const { state, receivedAt } = received;
  const duration = radioTrack(state.trackId)?.durationMs ?? 96_000;
  const elapsed = state.positionMs + (state.playing && state.startedAt !== null ? Math.max(0, state.serverNow - state.startedAt) + Math.max(0, now - receivedAt) : 0);
  // Hold at the end until the server chooses the next queued track.
  return Math.min(duration, Math.max(0, elapsed));
}
