import { RoomPage } from './features/room/RoomPage';

function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const roomId = /^\/room\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(path)?.[1];
  if (!roomId) {
    return <main className="not-found"><span className="brand-star" aria-hidden="true">✦</span><h1>This room is still among the stars.</h1><a className="primary-button" href="/room/demo">Back to the study room</a></main>;
  }
  return <RoomPage key={roomId} roomId={roomId} />;
}

export default App;
