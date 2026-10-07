import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadioCommand, RadioSnapshot, RadioTrackId } from '../../../../shared/radio';
import type { ConnectionStatus } from '../presence/useRoomPresence';
import { roomSocket } from '../../services/socket';
import { guestStorage } from '../../services/localStorage';
import { receiveRadio, radioElapsed, type ReceivedRadio } from './radioClock';
import { RadioAudio } from './radioAudio';

export function useRoomRadio(roomId: string, connection: ConnectionStatus, userId?: string) {
  const [received, setReceived] = useState<ReceivedRadio | null>(null);
  const latest = useRef<ReceivedRadio | null>(null);
  const retired = useRef(new Set<string>());
  const audio = useRef<RadioAudio | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [volume, setVolume] = useState(() => { const n = Number(guestStorage.get('constellate:radio-volume') ?? '.35'); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : .35; });
  const [muted, setMuted] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false), generation = useRef(0), endSync = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    audio.current = new RadioAudio(); latest.current = null; retired.current.clear(); setReceived(null); setEnabled(false); setError(null);
    const onState = (state: RadioSnapshot) => {
      if (state.roomId !== roomId || !roomSocket.connected || !roomSocket.id) return;
      const previous = latest.current;
      if (previous?.socketId !== roomSocket.id) retired.current.clear();
      if (retired.current.has(state.epoch)) return;
      if (previous?.socketId === roomSocket.id && previous.state.epoch !== state.epoch) retired.current.add(previous.state.epoch);
      const next = receiveRadio(previous, state, performance.now(), roomSocket.id);
      if (next !== previous) { latest.current = next; setReceived(next); }
    };
    const onDisconnect = () => { generation.current++; busy.current = false; setPending(false); audio.current?.stop(); };
    roomSocket.on('radio:state', onState); roomSocket.on('disconnect', onDisconnect);
    return () => { generation.current++; busy.current = false; roomSocket.off('radio:state', onState); roomSocket.off('disconnect', onDisconnect); audio.current?.dispose(); audio.current = null; };
  }, [roomId]);
  const request = useCallback((command: RadioCommand, trackId?: RadioTrackId, entryId?: string) => {
    if (connection !== 'connected' || !roomSocket.connected || busy.current) return;
    const id = ++generation.current, socketId = roomSocket.id;
    busy.current = true; setPending(true); setError(null);
    roomSocket.timeout(5000).emit('radio:command', { roomId, command, trackId, entryId }, (timeout: Error | null, result) => {
      if (id !== generation.current || socketId !== roomSocket.id || !roomSocket.connected) return;
      busy.current = false; setPending(false);
      if (timeout) setError('Radio did not respond. Reopen the panel to sync before trying again.');
      else if (!result?.ok) setError(result?.error ?? 'Unable to update the radio.');
    });
  }, [connection, roomId]);
  useEffect(() => {
    if (connection === 'connected') request('sync');
    else { generation.current++; busy.current = false; setPending(false); audio.current?.stop(); }
  }, [connection, request]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') request('sync'); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [request]);
  useEffect(() => {
    guestStorage.set('constellate:radio-volume', String(volume));
    audio.current?.volume(muted ? 0 : volume);
  }, [volume, muted, enabled]);
  useEffect(() => {
    const tick = () => {
      const current = latest.current;
      const position = radioElapsed(current, performance.now()); setElapsed(position);
      if (connection === 'connected' && current && current.socketId === roomSocket.id && roomSocket.connected && enabled) {
        if (!audio.current?.active) { setEnabled(false); return; }
        audio.current.sync(current.state.trackId, current.state.playing, position);
      } else audio.current?.stop();
      if (current?.state.playing && position >= 96_000 && performance.now() - endSync.current > 3000) {
        endSync.current = performance.now(); request('sync');
      }
    };
    tick(); const timer = window.setInterval(tick, 500); return () => window.clearInterval(timer);
  }, [connection, received, enabled, request]);
  const listen = async () => {
    const engine = audio.current;
    try { await engine?.enable(); if (engine === audio.current && engine) { engine.volume(muted ? 0 : volume); setEnabled(true); setError(null); } }
    catch (reason) { if (engine === audio.current) setError(reason instanceof Error ? reason.message : 'Audio is unavailable in this browser.'); }
  };
  const state = received?.state.roomId === roomId ? received.state : null;
  return { state, elapsed, enabled, listen, volume, setVolume, muted, setMuted, pending, error, request,
    ready: Boolean(state && connection === 'connected' && received?.socketId === roomSocket.id && roomSocket.connected),
    isHost: Boolean(userId && state?.hostId === userId) };
}
export type RoomRadioControls = ReturnType<typeof useRoomRadio>;
