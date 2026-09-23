import { useEffect, useState, type FormEvent } from 'react';
import { LogIn, LogOut, Plus, Users } from 'lucide-react';
import { getLastRoom, isRoomId } from '../presence/localSession';
import { useAuth } from '../auth/AuthProvider';
import { createAccountRoom, listAccountRooms, type AccountRoom } from '../../services/accountRooms';

const newRoomCode = () => `room-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

export function Dashboard() {
  const { user, loading, configured, signOut } = useAuth();
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ownedRooms, setOwnedRooms] = useState<AccountRoom[]>([]);
  const [creating, setCreating] = useState(false);
  const recent = getLastRoom();
  useEffect(() => {
    if (!user) { setOwnedRooms([]); return; }
    let active = true;
    void listAccountRooms().then(rooms => { if (active) setOwnedRooms(rooms); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Cannot load your rooms.'); });
    return () => { active = false; };
  }, [user]);
  const create = async () => {
    if (!user) { window.location.assign('/auth'); return; }
    setCreating(true); setError(null);
    try { const room = await createAccountRoom('Late night grind'); window.location.assign(`/r/${room.id}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Cannot create the room.'); setCreating(false); }
  };
  const join = (event: FormEvent) => {
    event.preventDefault(); const code = roomId.trim();
    if (!isRoomId(code)) { setError('Enter a valid room code.'); return; }
    window.location.assign(`/r/${encodeURIComponent(code)}`);
  };
  return <main className="product-page dashboard-page">
    <header className="product-nav"><a className="product-brand" href="/"><span className="brand-star">✦</span><span>constellate</span></a><nav>
      {loading ? <span className="account-label">Checking account…</span> : user ? <><span className="account-label">{user.email}</span><button className="secondary-button" onClick={() => void signOut()}><LogOut size={15}/> Sign out</button></> : <a className="secondary-button" href="/auth"><LogIn size={15}/> Sign in</a>}
    </nav></header>
    <section className="dashboard-hero"><p className="eyebrow">STUDY TOGETHER, FROM ANYWHERE</p><h1>Your quiet corner of the internet.</h1><p>Start a room, invite your people, and focus together in real time.</p></section>
    <section className="dashboard-grid">
      <article className="product-card action-card"><Plus/><h2>Create a room</h2><p>{user ? 'Create a room connected to your account.' : 'Open a guest room, or sign in to own it permanently.'}</p><button className="primary-button" disabled={creating} onClick={() => user ? void create() : window.location.assign(`/r/${newRoomCode()}`)}>{creating ? 'Creating…' : user ? 'Create owned room' : 'Create guest room'}</button></article>
      <article className="product-card action-card"><Users/><h2>Join a room</h2><p>Enter the code from a friend’s invitation.</p><form className="dashboard-join" onSubmit={join}><input aria-label="Room code" placeholder="demo" maxLength={64} value={roomId} onChange={event => { setRoomId(event.target.value); setError(null); }}/><button className="primary-button">Join</button></form>{error && <p className="join-error">{error}</p>}</article>
    </section>
    {error && <p className="dashboard-note join-error" role="alert">{error}</p>}
    {user && ownedRooms.length > 0 && <section className="owned-rooms"><p className="eyebrow">YOUR ROOMS</p>{ownedRooms.map(room => <a className="recent-room product-card" href={`/r/${room.id}`} key={room.id}><div><h2>{room.name}</h2><p>r/{room.id} · {room.visibility}</p></div><span className="secondary-button">Open room</span></a>)}</section>}
    {recent && <section className="recent-room product-card"><div><p className="eyebrow">RECENT ROOM</p><h2>{recent}</h2><p>Pick up where you left off.</p></div><a className="secondary-button" href={`/r/${encodeURIComponent(recent)}`}>Open room</a></section>}
    {!user && <p className="dashboard-note">{configured ? 'Sign in to establish your Constellate account. Guest rooms remain available.' : 'Guest mode is ready. Account features will appear after Supabase is connected.'}</p>}
    {user && ownedRooms.length === 0 && !error && <p className="dashboard-note">Create your first owned room. Private rooms and member roles come next.</p>}
  </main>;
}
