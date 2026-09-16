import { Coffee, Heart, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactionKind, RoomReaction } from '../../../../shared/reactions';
import type { ConnectionStatus } from '../../services/roomConnection';
import { roomSocket } from '../../services/socket';

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

export function ReactionsPanel({ roomId, connection }: { roomId: string; connection: ConnectionStatus }) {
  const [reactions, setReactions] = useState<RoomReaction[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onReaction = (reaction: RoomReaction) => {
      if (reaction.roomId !== roomId) return;
      setReactions(current => [...new Map([reaction, ...current].map(item => [item.id, item])).values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, 3));
      setAnnouncement(`${reaction.nickname} sent ${reaction.kind}`);
    };
    const onHistory = (payload: { roomId: string; reactions: RoomReaction[] }) => {
      if (payload.roomId === roomId) { setReactions([...payload.reactions].reverse()); setError(null); }
    };
    roomSocket.on('reaction:new', onReaction); roomSocket.on('reaction:history', onHistory);
    return () => { roomSocket.off('reaction:new', onReaction); roomSocket.off('reaction:history', onHistory); };
  }, [roomId]);
  const send = async (kind: ReactionKind) => {
    if (connection !== 'connected' || !roomSocket.connected) return;
    setError(null);
    try {
      const result = await roomSocket.timeout(5000).emitWithAck('reaction:send', { roomId, kind });
      if (!result.ok) setError(result.error);
    } catch { setError('Could not confirm that reaction. Try again after reconnecting.'); }
  };
  return (
    <section className="sidebar-panel reactions-panel" aria-labelledby="reactions-heading">
      <div className="panel-heading"><h2 id="reactions-heading"><Sparkles size={16} />Reactions</h2></div><p className="panel-description">a little nudge of encouragement</p>
      <div className="reaction-buttons">{reactionOptions.map(({ kind, label }) => <button className={`reaction-button reaction-button--${kind}`} key={kind} aria-label={label} title={label} disabled={connection !== 'connected'} onClick={() => { void send(kind); }}><ReactionIcon kind={kind} /></button>)}</div>
      <div className="recent-label">Recent<span /></div>
      <div className="recent-reactions">{reactions.map((reaction) => <div className="reaction-row" key={reaction.id} data-reaction-id={reaction.id}><span className="reaction-message"><strong>{reaction.nickname}</strong> sent <span className={`inline-reaction reaction-button--${reaction.kind}`} role="img" aria-label={reaction.kind}><ReactionIcon kind={reaction.kind} /></span></span><time dateTime={new Date(reaction.createdAt).toISOString()}>{new Date(reaction.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time></div>)}</div>
      {error && <p className="panel-footnote" role="alert">{error}</p>}
      <span className="sr-only" role="status">{announcement}</span>
    </section>
  );
}
