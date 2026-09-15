export interface VoiceParticipant { guestId: string; nickname: string; sessionId: string; muted: boolean }
export interface VoiceParticipants { roomId: string; epoch: string; revision: number; participants: VoiceParticipant[] }
export type VoiceJoinResult = { ok: true; sessionId: string; participants: VoiceParticipants } | { ok: false; error: string };
export interface VoiceJoinRequest { roomId: string; clientId: string; muted: boolean }
export interface VoiceTarget { roomId: string; sessionId: string; targetGuestId: string; targetSessionId: string; negotiationId: string }
export interface VoiceDescription { type: 'offer' | 'answer'; sdp: string }
export interface VoiceIce { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null }
export type VoiceSignalRequest = VoiceTarget & { description?: VoiceDescription; candidate?: VoiceIce };
export interface VoiceSignal { roomId: string; fromGuestId: string; fromSessionId: string; toSessionId: string; negotiationId: string; description?: VoiceDescription; candidate?: VoiceIce }
export type VoiceSignalEvent = 'voice:offer' | 'voice:answer' | 'voice:ice-candidate' | 'voice:restart';
