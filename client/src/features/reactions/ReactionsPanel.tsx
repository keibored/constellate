import { Coffee, Heart, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { mockReactions } from '../../data/mockRoom';
import type { Reaction, ReactionKind } from '../../types/room';

const reactionOptions: { kind: ReactionKind; label: string }[] = [
  { kind: 'coffee', label: 'Send coffee' }, { kind: 'sparkle', label: 'Send a star' },
  { kind: 'heart', label: 'Send some love' }, { kind: 'cry', label: 'Send a crying face' },
];

function ReactionIcon({ kind }: { kind: ReactionKind }) {
  if (kind === 'coffee') return <Coffee size={22} />;
  if (kind === 'sparkle') return <span className="reaction-star" aria-hidden="true">✦</span>;
  if (kind === 'heart') return <Heart size={22} />;
  return <span className="cry-face" aria-hidden="true">😭</span>;
}

export function ReactionsPanel() {
  const [reactions, setReactions] = useState<Reaction[]>(mockReactions);
  const [announcement, setAnnouncement] = useState('');
  const send = (kind: ReactionKind) => {
    const reaction: Reaction = { id: crypto.randomUUID(), memberId: 'kei', kind, timeLabel: 'just now' };
    setReactions((current) => [reaction, ...current].slice(0, 3));
    setAnnouncement(`${kind} reaction added`);
  };
  return (
    <section className="sidebar-panel reactions-panel" aria-labelledby="reactions-heading">
      <div className="panel-heading"><h2 id="reactions-heading"><Sparkles size={16} />Reactions</h2></div><p className="panel-description">a little nudge of encouragement</p>
      <div className="reaction-buttons">{reactionOptions.map(({ kind, label }) => <button className={`reaction-button reaction-button--${kind}`} key={kind} aria-label={label} title={label} onClick={() => send(kind)}><ReactionIcon kind={kind} /></button>)}</div>
      <div className="recent-label">Recent<span /></div>
      <div className="recent-reactions">{reactions.map((reaction) => <div className="reaction-row" key={reaction.id}><span className="reaction-message"><strong>{reaction.memberId}</strong> sent <span className={`inline-reaction reaction-button--${reaction.kind}`} role="img" aria-label={reaction.kind}><ReactionIcon kind={reaction.kind} /></span></span><time>{reaction.timeLabel}</time></div>)}</div>
      <span className="sr-only" role="status">{announcement}</span>
    </section>
  );
}
