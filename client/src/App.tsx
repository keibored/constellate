import { RoomPage } from './features/room/RoomPage';

function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (path !== '/' && path !== '/room/demo') {
    return <main className="not-found"><span className="brand-star" aria-hidden="true">✦</span><h1>This room is still among the stars.</h1><a className="primary-button" href="/room/demo">Back to the study room</a></main>;
  }
  return <RoomPage />;
}

export default App;
