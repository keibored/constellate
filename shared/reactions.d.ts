export type ReactionKind = 'coffee' | 'sparkle' | 'heart' | 'cry';
export interface RoomReaction { id: string; roomId: string; userId: string; nickname: string; kind: ReactionKind; createdAt: number }
