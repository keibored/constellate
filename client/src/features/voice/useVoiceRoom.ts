import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus } from '../../services/roomConnection';
import { roomSocket } from '../../services/socket';
import { emptyVoice, VoiceRoom, type VoiceSnapshot } from './webrtc';

export function useVoiceRoom(roomId: string, guestId: string | undefined, connection: ConnectionStatus) {
  const controller = useRef<VoiceRoom | null>(null);
  const [state, setState] = useState<VoiceSnapshot>(emptyVoice);
  useEffect(() => {
    setState(emptyVoice);
    if (!guestId) return;
    const voice = new VoiceRoom(roomSocket, roomId, guestId, setState);
    controller.current = voice;
    return () => { voice.dispose(); if (controller.current === voice) controller.current = null; };
  }, [roomId, guestId]);
  useEffect(() => { controller.current?.setRoomReady(connection === 'connected'); }, [connection, roomId, guestId]);
  const join = useCallback(async () => { await controller.current?.join(); }, []);
  const leave = useCallback(async () => { await controller.current?.leave(); }, []);
  const setMuted = useCallback(async (muted: boolean) => { await controller.current?.setMuted(muted); }, []);
  const enableAudio = useCallback(async () => { await controller.current?.enableAudio(); }, []);
  return { ...state, join, leave, setMuted, enableAudio };
}
export type VoiceControlsState = ReturnType<typeof useVoiceRoom>;
