import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemberPresence, PresenceJoined, PresenceLeft, PresenceList, PresenceStatus, PresenceUpdated, RoomError } from '../../../../shared/presence';
import { roomSocket } from '../../services/socket';
import type { LocalIdentity } from './localIdentity';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

function ordered(members: MemberPresence[]) {
  return members.sort((a, b) => a.connectedAt - b.connectedAt || a.userId.localeCompare(b.userId));
}

export function useRoomPresence(roomId: string, identity: LocalIdentity | null) {
  const [members, setMembers] = useState<MemberPresence[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<{ roomId: string; userId: string; status: PresenceStatus } | null>(null);
  const statusRequest = useRef(0);

  const updateStatus = useCallback((status: PresenceStatus) => {
    // Status choices are never queued offline and replayed over newer server state.
    if (!identity || connection !== 'connected' || !roomSocket.connected) return;
    const request = ++statusRequest.current;
    setStatusError(null);
    setPendingStatus({ roomId, userId: identity.userId, status });
    roomSocket.timeout(5_000).emit('status:update', { roomId, userId: identity.userId, status }, (timeoutError: Error | null, result) => {
      if (request !== statusRequest.current || !roomSocket.connected) return;
      // The broadcast updates authoritative members before the success acknowledgement.
      // Removing the overlay also rolls back a rejected choice to the latest server state.
      setPendingStatus(null);
      if (timeoutError) {
        setStatusError('Could not confirm your status. Reconnecting…');
        roomSocket.disconnect().connect();
      } else {
        setStatusError(result?.ok ? null : result?.error ?? 'Your status could not be changed. Try again.');
      }
    });
  }, [roomId, identity, connection]);

  useEffect(() => {
    const clearPendingStatus = () => { statusRequest.current++; setPendingStatus(null); };
    clearPendingStatus();
    setMembers([]);
    setError(null);
    setStatusError(null);
    if (!identity) { setConnection('idle'); return; }
    const { userId, nickname, avatar } = identity;
    let active = true;
    let joined = false;
    let attempt = 0;

    const join = () => {
      // Never buffer a join while offline: each new connection sends a fresh one.
      if (!roomSocket.connected) return;
      const currentAttempt = ++attempt;
      setConnection('connecting');
      setError(null);
      roomSocket.timeout(5_000).emit('room:join', {
        roomId, user: { id: userId, nickname, avatar },
      }, (timeoutError: Error | null, result) => {
        if (!active || currentAttempt !== attempt || !roomSocket.connected) return;
        if (timeoutError) {
          setError('The room did not respond. Reconnecting…');
          setConnection('reconnecting');
          roomSocket.disconnect().connect();
        } else if (!result?.ok) {
          setError(result?.error ?? 'Unable to join this room.');
          setConnection('error');
        }
      });
    };
    const onList = (payload: PresenceList) => {
      if (payload.roomId !== roomId) return;
      clearPendingStatus();
      setStatusError(null);
      setMembers(ordered([...new Map(payload.members.map(member => [member.userId, member])).values()]));
      joined = true;
      setConnection('connected');
      setError(null);
    };
    const onJoined = ({ roomId: eventRoom, member }: PresenceJoined) => {
      if (eventRoom !== roomId) return;
      setMembers(current => ordered([...current.filter(item => item.userId !== member.userId), member]));
    };
    const onLeft = ({ roomId: eventRoom, userId: leavingUser }: PresenceLeft) => {
      if (eventRoom === roomId) setMembers(current => current.filter(member => member.userId !== leavingUser));
    };
    const onUpdated = ({ roomId: eventRoom, member }: PresenceUpdated) => {
      if (eventRoom !== roomId) return;
      setMembers(current => current.map(item => item.userId === member.userId ? member : item));
    };
    const onDisconnect = (reason: string) => {
      attempt++;
      clearPendingStatus();
      setConnection('reconnecting');
      // Socket.IO retries transport failures itself, but not a server-forced disconnect.
      if (reason === 'io server disconnect') roomSocket.connect();
    };
    const onConnectError = () => {
      setConnection('reconnecting');
      setError('Cannot reach the room yet. Retrying automatically…');
    };
    const onRoomError = ({ message, operation }: RoomError) => {
      if (operation === 'status:update') { setStatusError(message); return; }
      if (operation?.startsWith('timer:')) return;
      setError(message);
      setConnection('error');
    };

    roomSocket.on('connect', join);
    roomSocket.on('disconnect', onDisconnect);
    roomSocket.on('connect_error', onConnectError);
    roomSocket.on('presence:list', onList);
    roomSocket.on('presence:joined', onJoined);
    roomSocket.on('presence:left', onLeft);
    roomSocket.on('presence:updated', onUpdated);
    roomSocket.on('room:error', onRoomError);
    setConnection('connecting');
    if (roomSocket.connected) join();
    else roomSocket.connect();

    return () => {
      active = false;
      statusRequest.current++;
      roomSocket.off('connect', join);
      roomSocket.off('disconnect', onDisconnect);
      roomSocket.off('connect_error', onConnectError);
      roomSocket.off('presence:list', onList);
      roomSocket.off('presence:joined', onJoined);
      roomSocket.off('presence:left', onLeft);
      roomSocket.off('presence:updated', onUpdated);
      roomSocket.off('room:error', onRoomError);
      // A room change leaves immediately; tab close/refresh uses the server grace period.
      if (joined && roomSocket.connected) roomSocket.emit('room:leave', { roomId }, () => {});
      roomSocket.disconnect();
    };
  }, [roomId, identity]);

  const displayedMembers = pendingStatus?.roomId === roomId
    ? members.map(member => member.userId === pendingStatus.userId ? { ...member, status: pendingStatus.status } : member)
    : members;
  return { members: displayedMembers, connection, error, updateStatus, statusError };
}
