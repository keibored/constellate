import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
import './styles/room.css';

if (window.location.pathname === '/') {
  window.history.replaceState(null, '', `/room/demo${window.location.search}${window.location.hash}`);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
