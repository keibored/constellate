import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomResult } from '../../../../shared/presence';
import type { RoomStatePayload } from '../../../../shared/roomState';
import type { ConnectionStatus } from '../../services/roomConnection';
import { roomSocket } from '../../services/socket';
import { receiveRoomState, type ReceivedRoomState } from './roomState';

type Action = { kind: 'sync' } | { kind: 'create'; title: string; requestId: string }
  | { kind: 'toggle'; taskId: string; completed: boolean } | { kind: 'delete'; taskId: string } | { kind: 'rename'; name: string };

function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useRoomState(roomId: string, connection: ConnectionStatus) {
  const [received, setReceived] = useState<ReceivedRoomState | null>(null);
  const latest = useRef<ReceivedRoomState | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const createKey = useRef<{ title: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    latest.current = null;
    createKey.current = null;
    setReceived(null);
    setSaving(false);
    setError(null);
    const cancel = () => { generation.current++; busy.current = false; setSaving(false); };
    const onState = (state: RoomStatePayload) => {
      if (state.roomId !== roomId || !roomSocket.connected || !roomSocket.id) return;
      const next = receiveRoomState(latest.current, state, roomSocket.id);
      latest.current = next;
      setReceived(next);
      setError(null);
    };
    roomSocket.on('room:state', onState);
    roomSocket.on('disconnect', cancel);
    return () => {
      generation.current++;
      busy.current = false;
      roomSocket.off('room:state', onState);
      roomSocket.off('disconnect', cancel);
    };
  }, [roomId]);

  const ready = received?.state.roomId === roomId && received.socketId === roomSocket.id && roomSocket.connected && connection === 'connected';
  const send = useCallback((action: Action): Promise<boolean> => {
    if (connection !== 'connected' || !roomSocket.connected || busy.current || (action.kind !== 'sync' && !ready)) return Promise.resolve(false);
    const request = ++generation.current;
    const socketId = roomSocket.id;
    busy.current = true;
    setSaving(true);
    setError(null);
    return new Promise(resolve => {
      const acknowledge = (timeoutError: Error | null, result?: RoomResult) => {
        if (request !== generation.current || socketId !== roomSocket.id || !roomSocket.connected) { resolve(false); return; }
        busy.current = false;
        setSaving(false);
        if (timeoutError) {
          setError('Could not confirm the save. Reconnecting to check the saved room…');
          roomSocket.disconnect().connect();
          resolve(false);
        } else if (!result?.ok) {
          setError(result?.error ?? 'Unable to save this change. Try again.');
          resolve(false);
        } else resolve(true);
      };
      const socket = roomSocket.timeout(5_000);
      if (action.kind === 'sync') socket.emit('tasks:sync', { roomId }, acknowledge);
      else if (action.kind === 'create') socket.emit('task:create', { roomId, title: action.title, requestId: action.requestId }, acknowledge);
      else if (action.kind === 'toggle') socket.emit('task:toggle', { roomId, taskId: action.taskId, completed: action.completed }, acknowledge);
      else if (action.kind === 'delete') socket.emit('task:delete', { roomId, taskId: action.taskId }, acknowledge);
      else socket.emit('room:rename', { roomId, name: action.name }, acknowledge);
    });
  }, [roomId, connection, ready]);

  // A join snapshot arrives before its acknowledgement; one follow-up sync closes
  // the initial-load/broadcast race. Later room updates do not trigger sync loops.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => { if (connection === 'connected') void sendRef.current({ kind: 'sync' }); }, [roomId, connection]);

  const createTask = async (draft: string) => {
    const title = draft.trim();
    if (!title || title.length > 100) { setError('Enter a task with 1–100 characters.'); return false; }
    if (!createKey.current || createKey.current.title !== title) createKey.current = { title, id: requestId() };
    const key = createKey.current;
    if (ready && latest.current?.state.tasks.some(task => task.requestId === key.id)) { createKey.current = null; return true; }
    const saved = await send({ kind: 'create', title, requestId: key.id });
    if (saved && createKey.current === key) createKey.current = null;
    return saved;
  };
  return {
    state: received?.state.roomId === roomId ? received.state : null, ready, saving, error, createTask,
    toggleTask: (taskId: string, completed: boolean) => send({ kind: 'toggle', taskId, completed }),
    deleteTask: (taskId: string) => send({ kind: 'delete', taskId }),
    rename: (name: string) => send({ kind: 'rename', name }),
    sync: () => send({ kind: 'sync' }),
  };
}
