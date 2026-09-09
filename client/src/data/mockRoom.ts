import type { Reaction, Room, Task } from '../types/room';

export const mockRoom: Room = {
  id: 'demo', name: 'late night grind', code: 'r/stellar-fox-27', motto: 'same stars, different desks ✦',
  members: [
    { id: 'kei', name: 'kei', status: 'coding', progress: 65 },
    { id: 'mika', name: 'mika', status: 'reading', progress: 55 },
    { id: 'ari', name: 'ari', status: 'dying', progress: 25 },
  ],
};

export const mockTasks: Task[] = [
  { id: 'task-1', title: 'Finish React components', completed: true, assigneeIds: ['kei'] },
  { id: 'task-2', title: 'Review WebSocket notes', completed: false, assigneeIds: ['kei', 'mika'] },
  { id: 'task-3', title: 'LeetCode because suffering', completed: false, assigneeIds: ['ari'] },
  { id: 'task-4', title: 'Plan weekend project', completed: false, assigneeIds: ['mika'] },
];

export const mockReactions: Reaction[] = [
  { id: 'reaction-1', memberId: 'mika', kind: 'coffee', timeLabel: '1m ago' },
  { id: 'reaction-2', memberId: 'kei', kind: 'sparkle', timeLabel: '2m ago' },
  { id: 'reaction-3', memberId: 'ari', kind: 'cry', timeLabel: '3m ago' },
];
