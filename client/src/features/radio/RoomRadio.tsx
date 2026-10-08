import { useEffect, useRef, useState } from 'react';
import { Radio, Play, Pause, SkipForward, Volume2, VolumeX, X, Plus, Crown, Music2, CloudRain, Coffee, ChevronDown } from 'lucide-react';
import type { MemberPresence } from '../../../../shared/presence';
import { RADIO_TRACKS, radioTrack } from '../../../../shared/radioCatalog.js';
import { useRoomRadio, type RoomRadioControls } from './useRoomRadio';
import type { ConnectionStatus } from '../presence/useRoomPresence';
import { RoomScene } from '../room/RoomScene';
import '../../styles/radio.css';

const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function RoomRadio({ radio, members, open, onOpenChange }: { radio: RoomRadioControls; members: MemberPresence[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<'music' | 'ambience'>('music');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const track = radioTrack(radio.state?.trackId ?? 'moonlit-notes')!;
  const host = members.find(member => member.userId === radio.state?.hostId)?.nickname;
  useEffect(() => {
    if (!open) return;
    radio.request('sync');
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { onOpenChange(false); trigger.current?.focus(); } };
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest('.scene-radio'))) onOpenChange(false); };
    document.addEventListener('keydown', key); document.addEventListener('mousedown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', outside); };
  }, [open, onOpenChange, radio.request]);
  const toggle = async () => {
    if (!radio.state?.playing) { await radio.listen(); radio.request('play'); }
    else radio.request('pause');
  };
  const volume = (id: string) => <div className="radio-volume">
    <button className="radio-icon-button" aria-label={radio.muted ? 'Unmute radio for yourself' : 'Mute radio for yourself'} aria-pressed={radio.muted} onClick={() => radio.setMuted(!radio.muted)}>{radio.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
    <label htmlFor={id}>Your volume<input id={id} type="range" min="0" max="1" step=".01" value={radio.volume} onChange={event => radio.setVolume(Number(event.target.value))} /></label>
  </div>;
  const controls = <>
    <button className="radio-play" disabled={!radio.ready || !radio.isHost || radio.pending} onClick={() => { void toggle(); }} aria-label={radio.state?.playing ? 'Pause shared radio' : 'Play shared radio'} title={!radio.isHost ? 'Playback is controlled by the radio host' : undefined}>{radio.state?.playing ? <Pause size={17} /> : <Play size={17} />}<span>{radio.state?.playing ? 'Pause' : 'Play'}</span></button>
    <button className="radio-icon-button" disabled={!radio.ready || !radio.isHost || radio.pending} onClick={() => radio.request('next')} aria-label="Skip to next track"><SkipForward size={18} /></button>
  </>;
  return <div className="room-radio" ref={root}>
    <section className="radio-strip" aria-label="Room radio player">
      <button ref={trigger} className="radio-strip-title" aria-expanded={open} aria-controls="room-radio-panel" onClick={() => onOpenChange(!open)}>
        <span className={`radio-miniature${radio.state?.playing ? ' radio-miniature--playing' : ''}`}><Radio size={26} /></span>
        <span><small>ROOM RADIO</small><strong>{track.title}</strong><em>{!radio.ready ? 'Connecting…' : radio.state?.playing ? 'playing together' : 'a little quiet for now'}</em></span><ChevronDown size={15} />
      </button>
      <div className="radio-strip-controls">{controls}</div>
      {!radio.enabled && <button className="radio-listen" onClick={() => { void radio.listen(); }} disabled={!radio.ready}><Volume2 size={15} />Listen</button>}
      {volume('radio-strip-volume')}
    </section>
    {radio.error && <p className="radio-error" role="status">{radio.error}</p>}
    {open && <section className="radio-panel" id="room-radio-panel" aria-labelledby="radio-panel-title">
      <header><h2 id="radio-panel-title"><Radio size={18} />Room radio</h2><button className="radio-icon-button" aria-label="Close room radio" onClick={() => { onOpenChange(false); trigger.current?.focus(); }}><X size={18} /></button></header>
      <div className="radio-tabs" aria-label="Radio library">
        <button aria-pressed={tab === 'music'} onClick={() => setTab('music')}><Music2 size={14} />Music</button>
        <button aria-pressed={tab === 'ambience'} onClick={() => { setTab('ambience'); setLibraryOpen(true); }}><CloudRain size={14} />Ambience</button>
      </div>
      <div className="radio-now-playing">
        <div className={`radio-art radio-art--${track.id}`} aria-hidden="true"><span>{track.symbol}</span><i /><b>✦</b></div>
        <div><strong>{track.title}</strong><p>{track.kind === 'music' ? 'Original lo-fi loop' : 'Gentle soundscape'}</p><small>{host ? `hosted by ${host}` : 'waiting for a host'}</small>
          <progress value={radio.elapsed} max={track.durationMs} aria-label="Current track progress" />
          <div className="radio-time"><span>{time(radio.elapsed)}</span><span>{time(track.durationMs)}</span></div>
        </div>
      </div>
      <div className="radio-panel-controls">{controls}{!radio.enabled && <button className="radio-listen" disabled={!radio.ready} onClick={() => { void radio.listen(); }}>Listen on this device</button>}</div>
      <div className="radio-queue-heading"><h3>Up next <span>{radio.state?.queue.length ?? 0}/12</span></h3><span>loops when the queue is empty</span></div>
      <ol className="radio-queue">{radio.state?.queue.map(entry => <li key={entry.id}>
        <span className="radio-queue-art" aria-hidden="true">{radioTrack(entry.trackId)?.symbol}</span><div><strong>{radioTrack(entry.trackId)?.title}</strong><small>added by {entry.nickname}</small></div>
        {radio.isHost && <button className="radio-icon-button" disabled={!radio.ready || radio.pending} aria-label={`Remove ${radioTrack(entry.trackId)?.title} from queue`} onClick={() => radio.request('remove', undefined, entry.id)}><X size={14} /></button>}
      </li>)}</ol>
      {!radio.state?.queue.length && <p className="radio-empty">Pick something soft for everyone to study to.</p>}
      <button className="radio-suggest" aria-expanded={libraryOpen} aria-controls="radio-library" onClick={() => setLibraryOpen(!libraryOpen)}><Plus size={16} />Suggest a track</button>
      {libraryOpen && <div className="radio-library" id="radio-library">{RADIO_TRACKS.filter(item => item.kind === tab).map(item => <div className="radio-library-row" key={item.id}>
        <span aria-hidden="true">{item.id === 'rain' ? <CloudRain size={16} /> : item.id === 'cafe' ? <Coffee size={16} /> : item.symbol}</span><strong>{item.title}</strong>
        {radio.isHost && <button disabled={!radio.ready || radio.pending} onClick={() => radio.request('select', item.id)} aria-label={`Choose ${item.title} as current track`}>Choose</button>}
        <button disabled={!radio.ready || radio.pending || (radio.state?.queue.length ?? 0) >= 12} onClick={() => radio.request('suggest', item.id)} aria-label={`Add ${item.title} to queue`}><Plus size={15} /></button>
      </div>)}</div>}
      <footer><p><Crown size={13} />{radio.isHost ? 'You control shared playback' : host ? `Playback controlled by ${host}` : 'Waiting for a host'}</p>{volume('radio-panel-volume')}</footer>
      <p className="radio-footnote">Volume and mute only affect you. Tap Listen to enable sound.</p>
    </section>}
  </div>;
}

// Keep the playback clock inside this area so chat, tasks and the page shell
// do not rerender on every progress tick.
export function RoomRadioArea({ roomId, connection, currentUserId, members }: { roomId: string; connection: ConnectionStatus; currentUserId?: string; members: MemberPresence[] }) {
  const radio = useRoomRadio(roomId, connection, currentUserId);
  const [open, setOpen] = useState(false);
  return <>
    <RoomScene members={members} onRadioOpen={() => setOpen(true)} radioOpen={open} />
    <RoomRadio radio={radio} members={members} open={open} onOpenChange={setOpen} />
  </>;
}
