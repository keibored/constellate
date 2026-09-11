import type { AvatarId } from './presence';

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  avatar: AvatarId;
  content: string;
  createdAt: number;
}

export interface ChatSendPayload { roomId: string; content: string }
export interface ChatHistory { roomId: string; messages: ChatMessage[] }
