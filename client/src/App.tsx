import { RoomPage } from './features/room/RoomPage';
import { RoomLobby } from './features/room/RoomLobby';
import { prewarmBackend } from './services/backendWarmup';

// Start waking Render while a visitor reads the page or enters a nickname.
if (import.meta.env.PROD) void prewarmBackend();

function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const queryRoomId = new URLSearchParams(window.location.search).get('room');
  if (queryRoomId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(queryRoomId)) return <RoomPage key={queryRoomId} roomId={queryRoomId} />;
  if (path === '/' || path === '/join') return <RoomLobby />;
  const roomId = /^\/(?:r|room)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(path)?.[1];
  if (!roomId) {
    return <main className="not-found"><span className="brand-star" aria-hidden="true">✦</span><h1>This room is still among the stars.</h1><a className="primary-button" href="/join">Choose a room</a></main>;
  }
  return <RoomPage key={roomId} roomId={roomId} />;
}

export default App;
