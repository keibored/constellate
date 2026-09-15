import type { roomSocket } from '../../services/socket';
import type { VoiceParticipant, VoiceParticipants, VoiceSignal, VoiceSignalEvent } from '../../../../shared/voice';
import { voiceIceServers } from './iceConfig';

export type VoiceStatus = 'idle' | 'joining' | 'joined' | 'reconnecting';
export interface VoiceSnapshot {
  status: VoiceStatus; muted: boolean; participants: VoiceParticipant[]; connectedPeers: number;
  error: string | null; playbackBlocked: boolean;
}
export const emptyVoice: VoiceSnapshot = { status: 'idle', muted: false, participants: [], connectedPeers: 0, error: null, playbackBlocked: false };
interface Peer {
  participant: VoiceParticipant; pc: RTCPeerConnection; audio: HTMLAudioElement; negotiationId: string | null;
  candidates: { id: string; candidate: RTCIceCandidateInit }[]; pending: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>; disposed: boolean;
}
export function microphoneError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission was denied. You can keep studying, or allow it in your browser and try again.';
  if (name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Your microphone is busy or unavailable. Check the device and try again.';
  return error instanceof Error ? error.message : 'Could not start voice. Please try again.';
}

/** Browser-local media only. Socket.IO carries bounded SDP/ICE messages, never audio. */
export class VoiceRoom {
  private state: VoiceSnapshot = { ...emptyVoice, participants: [] };
  private peers = new Map<string, Peer>();
  private retries = new Map<string, number>();
  private stream: MediaStream | null = null;
  private sessionId: string | null = null;
  private clientId = '';
  private wanted = false;
  private roomReady = false;
  private disposed = false;
  private generation = 0;
  private retention?: ReturnType<typeof setTimeout>;
  private rosterVersion: { epoch: string; revision: number } | null = null;
  private buffered: { event: VoiceSignalEvent; signal: VoiceSignal }[] = [];
  private iceServers: RTCIceServer[] = [];
  private signalHandlers: [VoiceSignalEvent, (signal: VoiceSignal) => void][];
  constructor(private socket: typeof roomSocket, private roomId: string, private guestId: string, private notify: (state: VoiceSnapshot) => void) {
    this.signalHandlers = (['voice:offer', 'voice:answer', 'voice:ice-candidate', 'voice:restart'] as const).map(event => [event, signal => this.receive(event, signal)]);
    socket.on('voice:participants', this.onParticipants);
    socket.on('disconnect', this.onDisconnect);
    for (const [event, handler] of this.signalHandlers) socket.on(event, handler);
    window.addEventListener('pagehide', this.onPageHide);
  }
  private publish(patch: Partial<VoiceSnapshot> = {}) {
    this.state = { ...this.state, ...patch, connectedPeers: [...this.peers.values()].filter(peer => peer.pc.connectionState === 'connected').length };
    if (!this.disposed) this.notify(this.state);
  }
  private usable() { return this.stream?.getAudioTracks().some(track => track.readyState === 'live') ?? false; }
  private enableTracks() { for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = this.state.status === 'joined' && !this.state.muted; }
  setRoomReady(ready: boolean) {
    this.roomReady = ready;
    if (!ready) this.onDisconnect();
    else if (this.wanted && this.usable() && this.state.status === 'reconnecting') void this.joinExisting();
  }
  async join() {
    if (this.disposed || this.wanted || !this.roomReady || !this.socket.connected) return;
    if (this.state.participants.some(participant => participant.guestId === this.guestId)) {
      this.publish({ error: "You're already connected to voice in another tab." }); return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      this.publish({ error: 'Voice needs a supported browser on localhost or HTTPS. The rest of the room is still available.' }); return;
    }
    const generation = ++this.generation;
    this.wanted = true; this.clientId = crypto.randomUUID();
    this.publish({ status: 'joining', error: null, muted: false });
    try {
      this.iceServers = voiceIceServers();
      // Only this explicit Join action requests media. There is no camera track.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== this.generation || !this.wanted || this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) { track.enabled = false; track.addEventListener('ended', this.onTrackEnded); }
      if (!this.usable()) throw new Error('The microphone did not provide a usable audio track.');
      await this.joinExisting();
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      await this.leave(); this.publish({ error: microphoneError(error) });
    }
  }
  private async joinExisting() {
    if (!this.wanted || !this.usable() || !this.roomReady || !this.socket.connected) return;
    const generation = ++this.generation;
    try {
      const result = await this.socket.timeout(5000).emitWithAck('voice:join', { roomId: this.roomId, clientId: this.clientId, muted: this.state.muted });
      if (generation !== this.generation || !this.wanted || this.disposed) return;
      if (!result.ok) throw new Error(result.error);
      clearTimeout(this.retention);
      this.sessionId = result.sessionId;
      this.publish({ status: 'joined', error: null }); this.enableTracks();
      this.onParticipants(result.participants); this.reconcile();
      const queued = this.buffered.splice(0);
      for (const item of queued) this.receive(item.event, item.signal);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      await this.leave();
      this.publish({ error: error instanceof Error && error.message !== 'operation has timed out' ? error.message : 'Voice did not connect. Try Join Voice again.' });
    }
  }
  private onParticipants = (payload: VoiceParticipants) => {
    if (payload.roomId !== this.roomId || this.disposed) return;
    if (this.rosterVersion?.epoch === payload.epoch && this.rosterVersion.revision >= payload.revision) return;
    this.rosterVersion = { epoch: payload.epoch, revision: payload.revision };
    for (const previous of this.state.participants) {
      if (!payload.participants.some(participant => participant.guestId === previous.guestId && participant.sessionId === previous.sessionId)) this.retries.delete(previous.guestId);
    }
    this.publish({ participants: payload.participants });
    if (this.state.status === 'joined' && !payload.participants.some(participant => participant.guestId === this.guestId && participant.sessionId === this.sessionId)) {
      void this.leave().then(() => this.publish({ error: 'Your voice connection ended. Click Join Voice to return.' })); return;
    }
    this.reconcile();
  };
  private reconcile() {
    if (this.state.status !== 'joined' || !this.sessionId || !this.usable()) return;
    const remote = this.state.participants.filter(participant => participant.guestId !== this.guestId);
    for (const [id, peer] of this.peers) if (!remote.some(participant => participant.guestId === id && participant.sessionId === peer.participant.sessionId)) {
      this.removePeer(id); this.retries.delete(id);
    }
    for (const participant of remote) if (!this.peers.has(participant.guestId) && !this.retries.has(participant.guestId)) {
      const peer = this.createPeer(participant);
      if (this.guestId < participant.guestId) void this.offer(peer);
    }
  }
  private alive(peer: Peer) { return !this.disposed && !peer.disposed && this.wanted && this.state.status === 'joined' && this.peers.get(peer.participant.guestId) === peer; }
  private createPeer(participant: VoiceParticipant): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true; audio.hidden = true; audio.setAttribute('playsinline', ''); audio.dataset.voicePeer = participant.guestId;
    document.body.append(audio);
    const peer: Peer = { participant, pc, audio, negotiationId: null, candidates: [], pending: Promise.resolve(), disposed: false };
    this.peers.set(participant.guestId, peer);
    for (const track of this.stream!.getAudioTracks()) pc.addTrack(track, this.stream!);
    pc.onicecandidate = event => {
      if (!event.candidate || !peer.negotiationId || !this.alive(peer)) return;
      const candidate = event.candidate.toJSON();
      void this.signal(peer, 'voice:ice-candidate', { candidate: { candidate: candidate.candidate ?? '', sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment } }).catch(() => {});
    };
    pc.ontrack = event => {
      if (!this.alive(peer) || event.track.kind !== 'audio') return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => { if (this.alive(peer)) this.publish({ playbackBlocked: true }); });
    };
    pc.onconnectionstatechange = () => {
      if (!this.alive(peer)) return;
      this.publish();
      if (pc.connectionState === 'connected') { clearTimeout(peer.timeout); return; }
      if (pc.connectionState === 'failed') this.recoverPeer(peer);
      else if (pc.connectionState === 'disconnected') {
        clearTimeout(peer.timeout); peer.timeout = setTimeout(() => { if (this.alive(peer) && pc.connectionState !== 'connected') this.recoverPeer(peer); }, 8000);
      }
    };
    peer.timeout = setTimeout(() => { if (this.alive(peer) && pc.connectionState !== 'connected') this.recoverPeer(peer); }, 15_000);
    return peer;
  }
  private async signal(peer: Peer, event: VoiceSignalEvent, data: Pick<VoiceSignal, 'candidate' | 'description'> = {}) {
    if (!this.alive(peer) || !this.sessionId || !peer.negotiationId) return;
    const result = await this.socket.timeout(5000).emitWithAck(event, { roomId: this.roomId, sessionId: this.sessionId,
      targetGuestId: peer.participant.guestId, targetSessionId: peer.participant.sessionId, negotiationId: peer.negotiationId, ...data });
    if (!result.ok) throw new Error(result.error);
  }
  private async offer(peer: Peer) {
    try {
      peer.negotiationId = crypto.randomUUID();
      const offer = await peer.pc.createOffer(); if (!this.alive(peer)) return;
      await peer.pc.setLocalDescription(offer); if (!this.alive(peer)) return;
      await this.signal(peer, 'voice:offer', { description: { type: 'offer', sdp: peer.pc.localDescription!.sdp } });
    } catch { if (this.alive(peer)) this.recoverPeer(peer); }
  }
  private receive(event: VoiceSignalEvent, signal: VoiceSignal) {
    if (signal.roomId !== this.roomId || this.disposed || !this.wanted) return;
    if (!this.sessionId) { if (this.buffered.length < 200) this.buffered.push({ event, signal }); return; }
    if (signal.toSessionId !== this.sessionId) return;
    const participant = this.state.participants.find(item => item.guestId === signal.fromGuestId && item.sessionId === signal.fromSessionId);
    if (!participant || participant.guestId === this.guestId) return;
    let peer = this.peers.get(participant.guestId);
    if (event === 'voice:restart') {
      if (this.guestId < participant.guestId && peer) this.recoverPeer(peer);
      return;
    }
    if (event === 'voice:offer') {
      if (this.guestId < participant.guestId || !signal.description) return; // Lower guest ID alone initiates.
      if (peer?.negotiationId && peer.negotiationId !== signal.negotiationId) { this.removePeer(participant.guestId); peer = undefined; }
      if (!peer) peer = this.createPeer(participant);
    }
    if (!peer) return;
    const target = peer;
    target.pending = target.pending.then(async () => {
      if (!this.alive(target)) return;
      if (event === 'voice:offer' && signal.description) {
        if (target.negotiationId === signal.negotiationId && target.pc.remoteDescription) return;
        target.negotiationId = signal.negotiationId;
        await target.pc.setRemoteDescription(signal.description); if (!this.alive(target)) return;
        await this.flushCandidates(target);
        const answer = await target.pc.createAnswer(); if (!this.alive(target)) return;
        await target.pc.setLocalDescription(answer); if (!this.alive(target)) return;
        await this.signal(target, 'voice:answer', { description: { type: 'answer', sdp: target.pc.localDescription!.sdp } });
      } else if (event === 'voice:answer' && signal.description && target.negotiationId === signal.negotiationId && target.pc.signalingState === 'have-local-offer') {
        await target.pc.setRemoteDescription(signal.description); if (this.alive(target)) await this.flushCandidates(target);
      } else if (event === 'voice:ice-candidate' && signal.candidate) {
        if (target.negotiationId === signal.negotiationId && target.pc.remoteDescription) await target.pc.addIceCandidate(signal.candidate);
        else if (target.candidates.length < 64) target.candidates.push({ id: signal.negotiationId, candidate: signal.candidate });
      }
    }).catch(() => { if (this.alive(target)) this.recoverPeer(target); });
  }
  private async flushCandidates(peer: Peer) {
    const candidates = peer.candidates.splice(0);
    for (const item of candidates) if (item.id === peer.negotiationId && this.alive(peer)) await peer.pc.addIceCandidate(item.candidate);
  }
  private recoverPeer(peer: Peer) {
    if (!this.alive(peer)) return;
    const id = peer.participant.guestId, attempts = this.retries.get(id) ?? 0;
    this.retries.set(id, attempts + 1);
    if (attempts >= 2) { this.removePeer(id); this.publish({ error: `Could not connect voice with ${peer.participant.nickname}. Leave voice and join again; this network may need a relay.` }); return; }
    if (this.guestId < id) {
      this.removePeer(id);
      const replacement = this.createPeer(peer.participant); void this.offer(replacement);
    } else {
      peer.negotiationId ??= crypto.randomUUID();
      void this.signal(peer, 'voice:restart').catch(() => {});
      this.removePeer(id);
    }
  }
  private removePeer(id: string) {
    const peer = this.peers.get(id); if (!peer) return;
    peer.disposed = true; clearTimeout(peer.timeout);
    peer.pc.onicecandidate = null; peer.pc.ontrack = null; peer.pc.onconnectionstatechange = null;
    peer.pc.close(); peer.audio.pause();
    const remoteStream = peer.audio.srcObject;
    if (remoteStream instanceof MediaStream) remoteStream.getTracks().forEach(track => track.stop());
    peer.audio.srcObject = null; peer.audio.remove();
    peer.candidates = []; this.peers.delete(id); this.publish();
  }
  async setMuted(muted: boolean) {
    this.publish({ muted }); this.enableTracks();
    if (!this.sessionId || this.state.status !== 'joined' || !this.socket.connected) return;
    try {
      const result = await this.socket.timeout(5000).emitWithAck('voice:mute-state', { roomId: this.roomId, sessionId: this.sessionId, muted });
      if (!result.ok) this.publish({ error: result.error });
    } catch { this.publish({ error: 'Your microphone setting changed locally, but the room could not confirm it yet.' }); }
  }
  async enableAudio() {
    const results = await Promise.allSettled([...this.peers.values()].filter(peer => peer.audio.srcObject).map(peer => peer.audio.play()));
    this.publish({ playbackBlocked: results.some(result => result.status === 'rejected') });
  }
  private onDisconnect = () => {
    this.roomReady = false;
    if (!this.wanted || this.state.status === 'reconnecting') return;
    if (!this.usable()) { void this.leave(); return; }
    ++this.generation; this.sessionId = null; this.buffered = [];
    for (const id of this.peers.keys()) this.removePeer(id);
    this.retries.clear(); this.publish({ status: 'reconnecting', playbackBlocked: false }); this.enableTracks();
    clearTimeout(this.retention);
    this.retention = setTimeout(() => { void this.leave().then(() => this.publish({ error: 'Voice was stopped after a minute offline. Join again when you are ready.' })); }, 60_000);
  };
  private onTrackEnded = () => { void this.leave().then(() => this.publish({ error: 'Your microphone disconnected. Check it and join voice again.' })); };
  private onPageHide = () => { void this.leave(); };
  async leave() {
    const clientId = this.clientId, notifyServer = this.wanted && clientId && this.socket.connected;
    ++this.generation; this.wanted = false; this.sessionId = null; this.buffered = [];
    clearTimeout(this.retention);
    for (const id of this.peers.keys()) this.removePeer(id);
    this.retries.clear();
    for (const track of this.stream?.getTracks() ?? []) { track.removeEventListener('ended', this.onTrackEnded); track.stop(); }
    this.stream = null; this.publish({ status: 'idle', muted: false, playbackBlocked: false });
    if (notifyServer) {
      try { await this.socket.timeout(3000).emitWithAck('voice:leave', { roomId: this.roomId, clientId }); } catch { /* Socket leases remove abandoned ownership. */ }
    }
  }
  dispose() {
    this.disposed = true; void this.leave();
    this.socket.off('voice:participants', this.onParticipants); this.socket.off('disconnect', this.onDisconnect);
    for (const [event, handler] of this.signalHandlers) this.socket.off(event, handler);
    window.removeEventListener('pagehide', this.onPageHide);
  }
}
