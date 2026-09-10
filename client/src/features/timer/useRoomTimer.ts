import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimerAction, TimerStatePayload } from '../../../../shared/timer';
import type { ConnectionStatus } from '../presence/useRoomPresence';
import { roomSocket } from '../../services/socket';

interface ReceivedTimer {
  state: TimerStatePayload;
  receivedAt: number;
  socketId: string;
}

export function useRoomTimer(roomId: string, connection: ConnectionStatus) {
  const [received, setReceived] = useState<ReceivedTimer | null>(null);
  const latest = useRef<ReceivedTimer | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const requestId = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    latest.current = null;
    setReceived(null);
    setError(null);
    const onState = (state: TimerStatePayload) => {
      if (state.roomId !== roomId || !roomSocket.connected || !roomSocket.id) return;
      const previous = latest.current;
      // A fresh socket may be talking to a restarted server whose revisions begin at zero.
      if (previous?.socketId === roomSocket.id && state.revision < previous.state.revision) return;
      const next = { state, receivedAt: performance.now(), socketId: roomSocket.id };
      latest.current = next;
      setReceived(next);
      setNow(next.receivedAt);
      setError(null);
    };
    roomSocket.on('timer:state', onState);
    return () => {
      requestId.current++;
      pendingRef.current = false;
      roomSocket.off('timer:state', onState);
    };
  }, [roomId]);

  const request = useCallback((action: TimerAction) => {
    if (connection !== 'connected' || !roomSocket.connected || pendingRef.current) return;
    const id = ++requestId.current;
    const socketId = roomSocket.id;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    // Never alter the canonical timer or queue a control while disconnected.
    roomSocket.timeout(5_000).emit(`timer:${action}`, { roomId }, (timeoutError: Error | null, result) => {
      if (id !== requestId.current || socketId !== roomSocket.id || !roomSocket.connected) return;
      pendingRef.current = false;
      setPending(false);
      if (timeoutError) {
        setError('Timer did not respond. Reconnecting…');
        roomSocket.disconnect().connect();
      } else if (!result?.ok) setError(result?.error ?? 'Unable to update the timer. Try again.');
    });
  }, [roomId, connection]);

  useEffect(() => {
    if (connection === 'connected') request('sync');
    else {
      requestId.current++;
      pendingRef.current = false;
      setPending(false);
    }
  }, [connection, request]);

  useEffect(() => {
    // A resumed/sleeping tab gets one fresh snapshot; there is no polling loop.
    const onVisible = () => { if (document.visibilityState === 'visible') request('sync'); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [request]);

  useEffect(() => {
    if (received?.state.status !== 'running') return;
    const interval = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(interval);
  }, [received]);

  const state = received?.state.roomId === roomId ? received.state : null;
  const elapsed = state?.status === 'running' && received ? Math.max(0, now - received.receivedAt) : 0;
  const remainingMs = state ? Math.max(0, state.remainingMs - elapsed) : 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const formattedTime = state ? `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}` : '--:--';
  const synchronized = Boolean(state && received?.socketId === roomSocket.id && roomSocket.connected && connection === 'connected');

  return {
    state, seconds, formattedTime, pending, error, canControl: synchronized && !pending,
    start: () => request('start'), pause: () => request('pause'), resume: () => request('resume'), reset: () => request('reset'),
  };
}
