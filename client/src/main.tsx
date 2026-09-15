import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
import './styles/room.css';
import './styles/presence.css';
import './styles/chat.css';
import './styles/session.css';
import { getLastRoom } from './features/presence/localSession';

if (window.location.pathname === '/') {
  const roomId = getLastRoom();
  if (roomId) window.history.replaceState(null, '', `/r/${roomId}${window.location.search}${window.location.hash}`);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
