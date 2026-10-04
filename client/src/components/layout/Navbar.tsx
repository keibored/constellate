import { BookOpen, History, Moon, Settings2 } from 'lucide-react';

interface NavbarProps { onSettings: () => void; dimmed: boolean; onToggleLights: () => void; onHome: () => void; statsOpen?: boolean }

export function Navbar({ onSettings, dimmed, onToggleLights, onHome, statsOpen = false }: NavbarProps) {
  const lightToggleLabel = dimmed ? 'Restore room lights' : 'Dim room lights';
  return (
    <header className="navbar room-navbar">
      <a href="/" className="brand" aria-label="Constellate home" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onHome(); } }}>
        <span className="brand-star" aria-hidden="true">✦</span>
        <span><span className="brand-name">Constellate</span></span>
      </a>
      <nav aria-label="Main navigation" className="nav-links">
        <a href="#room" className={`nav-link${statsOpen ? '' : ' active'}`} aria-current={statsOpen ? undefined : 'page'}><BookOpen size={16} />Room</a>
        <a href="#stats" className={`nav-link${statsOpen ? ' active' : ''}`} aria-current={statsOpen ? 'page' : undefined}><History size={15} />Stats</a>
      </nav>
      <div className="nav-end"><button className="icon-button" onClick={onSettings} aria-label="Room settings" title="Room settings"><Settings2 size={19} /></button><button className="icon-button theme-button" onClick={onToggleLights} aria-label={lightToggleLabel} aria-pressed={dimmed} title={lightToggleLabel}><Moon size={19} /></button></div>
    </header>
  );
}
