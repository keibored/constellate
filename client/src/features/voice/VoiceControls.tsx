import { Headphones, LogOut, Mic, MicOff, Volume2 } from 'lucide-react';
import type { ConnectionStatus } from '../../services/roomConnection';
import type { VoiceControlsState } from './useVoiceRoom';

export function VoiceControls({ voice, connection }: { voice: VoiceControlsState; connection: ConnectionStatus }) {
  const active = voice.status !== 'idle';
  return <div className="voice-controls" data-voice-state={voice.status} aria-label="Room voice">
    <div className="voice-heading"><span><Headphones size={14} />{voice.participants.length} in voice</span><span>optional · audio only</span></div>
    {!active ? <button className="invite-button" disabled={connection !== 'connected'} onClick={() => { void voice.join(); }}><Mic size={14} />Join Voice</button>
      : <div className="voice-buttons">
        {voice.status === 'joined' && <button className="invite-button" aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { void voice.setMuted(!voice.muted); }}>{voice.muted ? <MicOff size={14} /> : <Mic size={14} />}{voice.muted ? 'Unmute' : 'Mute'}</button>}
        <button className="invite-button" aria-label="Leave voice" onClick={() => { void voice.leave(); }}><LogOut size={14} />{voice.status === 'joining' ? 'Cancel' : 'Leave'}</button>
      </div>}
    {voice.status === 'joining' && <p className="voice-note" role="status">Waiting for your microphone and voice connection…</p>}
    {voice.status === 'reconnecting' && <p className="voice-note" role="status">Reconnecting voice. Your microphone is paused.</p>}
    {voice.status === 'joined' && <p className="voice-note" role="status">{voice.muted ? 'Your microphone is muted.' : 'Your microphone is on.'}{voice.participants.length > 1 ? ` ${voice.connectedPeers} peer${voice.connectedPeers === 1 ? '' : 's'} connected.` : ' A quiet voice corner, for now.'}</p>}
    {voice.playbackBlocked && <button className="invite-button" onClick={() => { void voice.enableAudio(); }}><Volume2 size={14} />Enable audio</button>}
    {voice.error && <p className="voice-note voice-error" role="alert">{voice.error}</p>}
  </div>;
}
