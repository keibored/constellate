export type RadioTrackId = 'moonlit-notes' | 'soft-morning' | 'window-seat' | 'rain' | 'cafe';
export type RadioCommand = 'play' | 'pause' | 'next' | 'select' | 'suggest' | 'remove' | 'sync';
export interface RadioRequest { roomId: string; command: RadioCommand; trackId?: RadioTrackId; entryId?: string }
export interface RadioEntry { id: string; trackId: RadioTrackId; nickname: string }
export interface RadioState {
  hostId: string | null; trackId: RadioTrackId; playing: boolean;
  positionMs: number; startedAt: number | null; queue: RadioEntry[];
}
export interface RadioSnapshot extends RadioState { roomId: string; epoch: string; revision: number; serverNow: number }
