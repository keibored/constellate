import { BookOpen, Moon, Settings2, Users } from 'lucide-react';

interface NavbarProps { onSettings: () => void; dimmed: boolean; onToggleLights: () => void }

export function Navbar({ onSettings, dimmed, onToggleLights }: NavbarProps) {
  return (
    <header className="navbar">
      <a href="/room/demo" className="brand" aria-label="Constellate home">
        <span className="brand-star" aria-hidden="true">✦</span>
        <span><span className="brand-name">Constellate</span><span className="brand-tagline">study together, further</span></span>
      </a>
      <nav aria-label="Main navigation" className="nav-links">
        <a href="#room" className="nav-link active" aria-current="page"><BookOpen size={16} />Room</a>
        <a href="#quests" className="nav-link">Tasks</a>
        <a href="#members" className="nav-link"><Users size={15} className="mobile-nav-icon" />Members</a>
        <button className="nav-link" onClick={onSettings}><Settings2 size={15} className="mobile-nav-icon" />Settings</button>
      </nav>
      <div className="nav-end"><span className="night-label">a good night to begin</span><button className="icon-button theme-button" onClick={onToggleLights} aria-label="Dim room lights" aria-pressed={dimmed} title="Dim room lights"><Moon size={19} /></button></div>
    </header>
  );
}
