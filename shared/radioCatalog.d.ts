import type { RadioTrackId } from './radio';
export interface RadioTrack { id: RadioTrackId; title: string; kind: 'music' | 'ambience'; durationMs: number; symbol: string }
export const RADIO_TRACKS: readonly RadioTrack[];
export function radioTrack(id: unknown): RadioTrack | undefined;
