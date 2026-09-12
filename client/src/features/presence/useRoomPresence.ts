import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemberPresence, PresenceJoined, PresenceLeft, PresenceList, PresenceStatus, PresenceUpdated, RoomError } from '../../../../shared/presence';
import { logRoomEvent, roomSocket } from '../../services/socket';
import { connectRoom, type ConnectionStatus } from '../../services/roomConnection';
import type { LocalIdentity } from './localIdentity';

export type { ConnectionStatus } from '../../services/roomConnection';

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
  const reconnectRef = useRef<() => void>(() => {});
  const reconnect = useCallback(() => reconnectRef.current(), []);

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
    const onList = (payload: PresenceList) => {
      if (payload.roomId !== roomId) return;
      clearPendingStatus();
      setStatusError(null);
      setMembers(ordered([...new Map(payload.members.map(member => [member.userId, member])).values()]));
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
    const onRoomError = ({ message, operation }: RoomError) => {
      if (operation === 'status:update') setStatusError(message);
    };

    roomSocket.on('presence:list', onList);
    roomSocket.on('presence:joined', onJoined);
    roomSocket.on('presence:left', onLeft);
    roomSocket.on('presence:updated', onUpdated);
    roomSocket.on('room:error', onRoomError);
    const subscription = connectRoom(roomSocket, roomId, { id: userId, nickname, avatar }, {
      connection: setConnection, error: setError, disconnected: clearPendingStatus, log: logRoomEvent,
    });
    reconnectRef.current = subscription.retry;

    return () => {
      statusRequest.current++;
      reconnectRef.current = () => {};
      roomSocket.off('presence:list', onList);
      roomSocket.off('presence:joined', onJoined);
      roomSocket.off('presence:left', onLeft);
      roomSocket.off('presence:updated', onUpdated);
      roomSocket.off('room:error', onRoomError);
      subscription.dispose();
    };
  }, [roomId, identity]);

  const displayedMembers = pendingStatus?.roomId === roomId
    ? members.map(member => member.userId === pendingStatus.userId ? { ...member, status: pendingStatus.status } : member)
    : members;
  return { members: displayedMembers, connection, error, reconnect, updateStatus, statusError };
}
