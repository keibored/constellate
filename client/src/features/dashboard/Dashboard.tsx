import { useState, type FormEvent } from 'react';
import { LogIn, LogOut, Plus, Users } from 'lucide-react';
import { getLastRoom, isRoomId } from '../presence/localSession';
import { useAuth } from '../auth/AuthProvider';

const newRoomCode = () => `room-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

export function Dashboard() {
  const { user, loading, configured, signOut } = useAuth();
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recent = getLastRoom();
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
      <article className="product-card action-card"><Plus/><h2>Create a room</h2><p>Open a fresh shared space with a unique invite code.</p><button className="primary-button" onClick={() => window.location.assign(`/r/${newRoomCode()}`)}>Create room</button></article>
      <article className="product-card action-card"><Users/><h2>Join a room</h2><p>Enter the code from a friend’s invitation.</p><form className="dashboard-join" onSubmit={join}><input aria-label="Room code" placeholder="demo" maxLength={64} value={roomId} onChange={event => { setRoomId(event.target.value); setError(null); }}/><button className="primary-button">Join</button></form>{error && <p className="join-error">{error}</p>}</article>
    </section>
    {recent && <section className="recent-room product-card"><div><p className="eyebrow">RECENT ROOM</p><h2>{recent}</h2><p>Pick up where you left off.</p></div><a className="secondary-button" href={`/r/${encodeURIComponent(recent)}`}>Open room</a></section>}
    {!user && <p className="dashboard-note">{configured ? 'Sign in to establish your Constellate account. Guest rooms remain available.' : 'Guest mode is ready. Account features will appear after Supabase is connected.'}</p>}
    {user && <p className="dashboard-note">Account connected. Owned rooms and synced history are next in Constellate v2.</p>}
  </main>;
}
