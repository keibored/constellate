import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHistory, ChatMessage } from '../../../../shared/chat';
import type { ConnectionStatus } from '../presence/useRoomPresence';
import { roomSocket } from '../../services/socket';

// Match the server's recent-history cap so long-lived tabs also stay bounded.
const MAX_MESSAGES = 100;

export function useRoomChat(roomId: string, connection: ConnectionStatus) {
  const [snapshot, setSnapshot] = useState<{ roomId: string; messages: ChatMessage[]; socketId?: string }>({ roomId, messages: [] });
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const requestId = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSnapshot({ roomId, messages: [] });
    setError(null);
    const onHistory = (history: ChatHistory) => {
      if (history.roomId !== roomId || !roomSocket.connected) return;
      const messages = [...new Map(history.messages.filter(message => message.roomId === roomId).map(message => [message.id, message])).values()].slice(-MAX_MESSAGES);
      setSnapshot({ roomId, messages, socketId: roomSocket.id });
      setError(null);
    };
    const onMessage = (message: ChatMessage) => {
      if (message.roomId !== roomId || !roomSocket.connected) return;
      setSnapshot(current => {
        if (current.roomId !== roomId || current.messages.some(item => item.id === message.id)) return current;
        return { ...current, messages: [...current.messages, message].slice(-MAX_MESSAGES) };
      });
    };
    roomSocket.on('chat:history', onHistory);
    roomSocket.on('chat:message', onMessage);
    return () => {
      requestId.current++;
      sendingRef.current = false;
      roomSocket.off('chat:history', onHistory);
      roomSocket.off('chat:message', onMessage);
    };
  }, [roomId]);

  useEffect(() => {
    if (connection !== 'connected') {
      requestId.current++;
      sendingRef.current = false;
      setSending(false);
    }
  }, [connection]);

  const ready = snapshot.roomId === roomId && snapshot.socketId === roomSocket.id && roomSocket.connected && connection === 'connected';
  const sendMessage = useCallback((draft: string): Promise<boolean> => {
    const content = draft.trim();
    if (!ready || !roomSocket.connected || sendingRef.current) return Promise.resolve(false);
    if (!content || content.length > 500) {
      setError('Enter a message of 1–500 characters.');
      return Promise.resolve(false);
    }
    const id = ++requestId.current;
    const socketId = roomSocket.id;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    return new Promise(resolve => {
      roomSocket.timeout(5_000).emit('chat:send', { roomId, content }, (timeoutError: Error | null, result) => {
        if (id !== requestId.current || socketId !== roomSocket.id || !roomSocket.connected) { resolve(false); return; }
        sendingRef.current = false;
        setSending(false);
        if (timeoutError) {
          setError('Could not confirm delivery. Reconnecting to check chat…');
          // Recover history, never automatically resend a possibly accepted message.
          roomSocket.disconnect().connect();
          resolve(false);
        } else if (!result?.ok) {
          setError(result?.error ?? 'Your message could not be sent. Try again.');
          resolve(false);
        } else resolve(true);
      });
    });
  }, [roomId, ready]);

  return { messages: snapshot.roomId === roomId ? snapshot.messages : [], sendMessage, sending, error, ready };
}
