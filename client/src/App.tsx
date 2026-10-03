import { RoomPage } from './features/room/RoomPage';
import { RoomLobby } from './features/room/RoomLobby';
import { prewarmBackend } from './services/backendWarmup';
import { AuthPage } from './features/auth/AuthPage';
import { Dashboard } from './features/dashboard/Dashboard';
import { ConsentBanner } from './components/privacy/ConsentBanner';
import { LegalPage } from './features/legal/LegalPage';
import { PageMeta } from './components/seo/PageMeta';
import type { ReactNode } from 'react';
import { OptionalAnalytics } from './components/privacy/OptionalAnalytics';

// Start waking Render while a visitor reads the page or enters a nickname.
if (import.meta.env.PROD) void prewarmBackend();

function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const queryRoomId = new URLSearchParams(window.location.search).get('room');
  let page: ReactNode;
  if (queryRoomId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(queryRoomId)) page = <><PageMeta title="Study room · Constellate" description="A shared real-time space to focus together." noIndex/><RoomPage key={queryRoomId} roomId={queryRoomId} /></>;
  else if (path === '/') page = <><PageMeta title="Constellate · Study together, further" description="Create a cozy real-time study room with synchronized focus timers, tasks, chat, voice, and shared progress."/><Dashboard /></>;
  else if (path === '/auth') page = <><PageMeta title="Sign in · Constellate" description="Sign in or create your Constellate study account." noIndex/><AuthPage /></>;
  else if (path === '/join') page = <><PageMeta title="Join a study room · Constellate" description="Enter a Constellate room code and focus with your study group."/><RoomLobby /></>;
  else if (path === '/privacy') page = <><PageMeta title="Privacy notice · Constellate" description="Learn what Constellate stores, why it is used, and the privacy choices available to you."/><LegalPage kind="privacy" /></>;
  else if (path === '/terms') page = <><PageMeta title="Terms of use · Constellate" description="The rules and expectations for using Constellate study rooms."/><LegalPage kind="terms" /></>;
  else {
    const roomId = /^\/(?:r|room)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(path)?.[1];
    page = roomId
      ? <><PageMeta title="Study room · Constellate" description="A shared real-time space to focus together." noIndex/><RoomPage key={roomId} roomId={roomId} /></>
      : <main className="not-found"><PageMeta title="Page not found · Constellate" description="This Constellate page could not be found." noIndex/><span className="brand-star" aria-hidden="true">✦</span><p className="eyebrow">404 · LOST IN THE NIGHT SKY</p><h1>This page is still among the stars.</h1><p>The link may be outdated, or the room code may have changed.</p><div className="not-found-actions"><a className="primary-button" href="/">Return home</a><a className="secondary-button" href="/join">Join a room</a></div></main>;
  }
  return <>{page}<ConsentBanner /><OptionalAnalytics /></>;
}

export default App;
