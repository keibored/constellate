import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { ConnectionStatus } from '../presence/useRoomPresence';
import { useRoomChat } from './useRoomChat';

interface RoomChatProps { roomId: string; currentUserId?: string; connection: ConnectionStatus }
const localTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function RoomChat({ roomId, currentUserId, connection }: RoomChatProps) {
  const { messages, sendMessage, sending, error, ready } = useRoomChat(roomId, connection);
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  useLayoutEffect(() => {
    if (nearBottom.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = draft;
    if (await sendMessage(submitted)) setDraft(current => current === submitted ? '' : current);
  };
  const note = error ?? (!ready ? connection === 'reconnecting' ? 'Reconnecting to chat…' : 'Join the room to say hello.' : 'a little company, a few words');

  return (
    <section className="sidebar-panel room-chat" aria-labelledby="chat-heading">
      <div className="panel-heading"><h2 id="chat-heading"><MessageSquare size={16} />Room Chat</h2><span className="panel-sparkle" aria-hidden="true">✧</span></div>
      <div className="chat-log" ref={logRef} role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions" tabIndex={0} onScroll={event => {
        const log = event.currentTarget;
        nearBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
      }}>
        {!messages.length && <p className="chat-empty">A quiet little corner.<br />Say hello when you're ready.</p>}
        {messages.map(message => <div key={message.id} data-message-id={message.id} data-user-id={message.userId} className={`chat-message${message.userId === currentUserId ? ' chat-message--self' : ''}`}>
          <Avatar avatar={message.avatar} small />
          <div className="chat-message-body">
            <div className="chat-message-heading"><strong>{message.nickname}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{localTime.format(message.createdAt)}</time></div>
            <p className="chat-message-content">{message.content}</p>
          </div>
        </div>)}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input aria-label="Message" placeholder="type a message…" maxLength={500} value={draft} autoComplete="off" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
        <button className="chat-send" type="submit" aria-label="Send message" aria-busy={sending} disabled={!ready || sending || !draft.trim() || draft.trim().length > 500}><Send size={15} /></button>
      </form>
      <p className={`chat-note${error ? ' chat-note--error' : ''}`} role="status">{note}</p>
    </section>
  );
}
