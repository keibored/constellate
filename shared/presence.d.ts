import type { TimerAction, TimerRequest, TimerStatePayload } from './timer';
import type { ChatHistory, ChatMessage, ChatSendPayload } from './chat';

export type AvatarId = 'dark' | 'pink' | 'green';
export type PresenceStatus = 'coding' | 'reading' | 'writing' | 'studying' | 'break' | 'dying';
export type DeskId = 'desk-1' | 'desk-2' | 'desk-3';

export interface RoomUser {
  id: string;
  nickname: string;
  avatar: AvatarId;
}

export interface MemberPresence {
  userId: string;
  nickname: string;
  avatar: AvatarId;
  status: PresenceStatus;
  connectedAt: number;
  connected: boolean;
  deskId: DeskId | null;
}

export interface RoomJoinPayload { roomId: string; user: RoomUser }
export interface PresenceList { roomId: string; members: MemberPresence[] }
export interface PresenceJoined { roomId: string; member: MemberPresence }
export interface PresenceUpdated { roomId: string; member: MemberPresence }
export interface PresenceLeft { roomId: string; userId: string }
export interface StatusUpdatePayload { roomId: string; userId: string; status: PresenceStatus }
export interface RoomError { message: string; operation?: 'status:update' | `timer:${TimerAction}` | 'chat:send' }
export type RoomResult = { ok: true } | { ok: false; error: string };

export interface ClientToServerEvents {
  'room:join': (payload: RoomJoinPayload, acknowledge: (result: RoomResult) => void) => void;
  'room:leave': (payload: { roomId: string }, acknowledge: (result: RoomResult) => void) => void;
  'status:update': (payload: StatusUpdatePayload, acknowledge: (result: RoomResult) => void) => void;
  'timer:start': (payload: TimerRequest, acknowledge: (result: RoomResult) => void) => void;
  'timer:pause': (payload: TimerRequest, acknowledge: (result: RoomResult) => void) => void;
  'timer:resume': (payload: TimerRequest, acknowledge: (result: RoomResult) => void) => void;
  'timer:reset': (payload: TimerRequest, acknowledge: (result: RoomResult) => void) => void;
  'timer:sync': (payload: TimerRequest, acknowledge: (result: RoomResult) => void) => void;
  'chat:send': (payload: ChatSendPayload, acknowledge: (result: RoomResult) => void) => void;
}

export interface ServerToClientEvents {
  'presence:list': (payload: PresenceList) => void;
  'presence:joined': (payload: PresenceJoined) => void;
  'presence:left': (payload: PresenceLeft) => void;
  'presence:updated': (payload: PresenceUpdated) => void;
  'timer:state': (payload: TimerStatePayload) => void;
  'chat:message': (payload: ChatMessage) => void;
  'chat:history': (payload: ChatHistory) => void;
  'room:error': (payload: RoomError) => void;
}
