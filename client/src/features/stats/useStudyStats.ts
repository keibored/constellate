import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonalStats, RoomStudyStats, StudyHistory } from '../../../../shared/stats';
import type { ConnectionStatus } from '../../services/roomConnection';
import { roomSocket } from '../../services/socket';
import { apiUrl } from '../../services/api';

export function useStudyStats(roomId: string, connection: ConnectionStatus) {
  const [personal, setPersonal] = useState<PersonalStats | null>(null);
  const [room, setRoom] = useState<RoomStudyStats | null>(null);
  const [history, setHistory] = useState<StudyHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const token = useRef<string | null>(null);
  const busy = useRef(false);

  const read = async <T,>(path: string, credential: string, signal: AbortSignal): Promise<T> => {
    const response = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${credential}` }, signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not load your study history.');
    return data as T;
  };
  const refresh = useCallback(async () => {
    if (connection !== 'connected' || !roomSocket.connected) return;
    const id = ++request.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    busy.current = true; setLoading(true); setError(null);
    try {
      const result = await roomSocket.timeout(5000).emitWithAck('stats:access', { roomId });
      if (id !== request.current || !roomSocket.connected) return;
      if (!result.ok) throw new Error(result.error);
      token.current = result.token;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const [nextPersonal, nextHistory, nextRoom] = await Promise.all([
        read<PersonalStats>(`/api/stats/me?timezone=${encodeURIComponent(timezone)}`, result.token, abort.signal),
        read<StudyHistory>('/api/stats/me/sessions?limit=10', result.token, abort.signal),
        read<RoomStudyStats>(`/api/rooms/${encodeURIComponent(roomId)}/stats`, result.token, abort.signal),
      ]);
      if (id !== request.current) return;
      setPersonal(nextPersonal); setHistory(nextHistory); setRoom(nextRoom);
    } catch (failure) {
      if (id === request.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load your study history.');
    } finally { if (id === request.current) { busy.current = false; setLoading(false); } }
  }, [roomId, connection]);

  useEffect(() => {
    if (connection === 'connected') void refresh();
    else { token.current = null; setLoading(false); }
    return () => { request.current++; controller.current?.abort(); busy.current = false; };
  }, [connection, refresh]);

  const loadMore = async () => {
    if (!history?.nextCursor || !token.current || busy.current || connection !== 'connected') return;
    const id = ++request.current;
    const abort = new AbortController(); controller.current = abort;
    busy.current = true; setLoading(true); setError(null);
    try {
      const next = await read<StudyHistory>(`/api/stats/me/sessions?limit=10&cursor=${encodeURIComponent(history.nextCursor)}`, token.current, abort.signal);
      if (id === request.current) setHistory(current => ({ sessions: [...new Map([...(current?.sessions ?? []), ...next.sessions].map(session => [session.id, session])).values()], nextCursor: next.nextCursor }));
    } catch (failure) {
      if (id === request.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load more sessions.');
    } finally { if (id === request.current) { busy.current = false; setLoading(false); } }
  };
  return { personal, room, history, loading, error, refresh, loadMore };
}
