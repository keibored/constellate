export type MemberId = 'kei' | 'mika' | 'ari';
export type MemberStatus = 'coding' | 'reading' | 'dying';
export type ReactionKind = 'coffee' | 'sparkle' | 'heart' | 'cry';

export interface Member {
  id: MemberId;
  name: string;
  status: MemberStatus;
  progress: number;
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  assigneeIds: MemberId[];
}

export interface Reaction {
  id: string;
  memberId: MemberId;
  kind: ReactionKind;
  timeLabel: string;
}

export interface Room {
  id: string;
  name: string;
  code: string;
  motto: string;
  members: Member[];
}
