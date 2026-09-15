import { BookOpen, History, Moon, Settings2, Users } from 'lucide-react';

interface NavbarProps { onSettings: () => void; dimmed: boolean; onToggleLights: () => void; onHome: () => void; statsOpen?: boolean }

export function Navbar({ onSettings, dimmed, onToggleLights, onHome, statsOpen = false }: NavbarProps) {
  return (
    <header className="navbar">
      <a href="/join" className="brand" aria-label="Constellate home" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onHome(); } }}>
        <span className="brand-star" aria-hidden="true">✦</span>
        <span><span className="brand-name">Constellate</span><span className="brand-tagline">study together, further</span></span>
      </a>
      <nav aria-label="Main navigation" className="nav-links">
        <a href="#room" className={`nav-link${statsOpen ? '' : ' active'}`} aria-current={statsOpen ? undefined : 'page'}><BookOpen size={16} />Room</a>
        <a href="#quests" className="nav-link">Tasks</a>
        <a href="#members" className="nav-link"><Users size={15} className="mobile-nav-icon" />Members</a>
        <a href="#stats" className={`nav-link${statsOpen ? ' active' : ''}`} aria-current={statsOpen ? 'page' : undefined}><History size={15} className="mobile-nav-icon" />Stats</a>
        <button className="nav-link" onClick={onSettings}><Settings2 size={15} className="mobile-nav-icon" />Settings</button>
      </nav>
      <div className="nav-end"><span className="night-label">a good night to begin</span><button className="icon-button theme-button" onClick={onToggleLights} aria-label="Dim room lights" aria-pressed={dimmed} title="Dim room lights"><Moon size={19} /></button></div>
    </header>
  );
}
