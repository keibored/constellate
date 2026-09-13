import type { AvatarId } from './presence';

export interface StoredRoom {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoomTask {
  id: string;
  roomId: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  creatorName: string;
  creatorAvatar: AvatarId;
  requestId: string;
}

export interface RoomStatePayload {
  roomId: string;
  room: StoredRoom;
  tasks: RoomTask[];
  revision: number;
}

export interface TaskCreatePayload { roomId: string; title: string; requestId: string }
export interface TaskTogglePayload { roomId: string; taskId: string; completed: boolean }
export interface TaskDeletePayload { roomId: string; taskId: string }
export interface RoomRenamePayload { roomId: string; name: string }
export type PersistentOperation = 'task:create' | 'task:toggle' | 'task:delete' | 'tasks:sync' | 'room:rename';
