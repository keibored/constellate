import type { PresenceStatus } from '../../../../shared/presence';

interface StatusDetails {
  icon: string;
  label: string;
  activity: string;
}

export const statusDetails: Record<PresenceStatus, StatusDetails> = {
  coding: { icon: '💻', label: 'Coding', activity: 'coding' },
  reading: { icon: '📖', label: 'Reading', activity: 'reading a book' },
  writing: { icon: '✍️', label: 'Writing', activity: 'writing' },
  studying: { icon: '📚', label: 'Studying', activity: 'studying' },
  break: { icon: '☕', label: 'Break', activity: 'taking a break' },
  dying: { icon: '😵', label: 'Dying', activity: 'resting their head on the desk' },
};

export const statusOptions = (Object.entries(statusDetails) as [PresenceStatus, StatusDetails][])
  .map(([value, details]) => ({ value, ...details }));
