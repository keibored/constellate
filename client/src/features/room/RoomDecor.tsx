import type { CSSProperties } from 'react';
import { NightSky } from './NightSky';

export function Plant({ className = '' }: { className?: string }) {
  return <div className={`plant ${className}`}><span className="plant-stem" />{Array.from({ length: 6 }, (_, index) => <i className={`leaf leaf-${index}`} key={index} />)}<span className="plant-pot" /></div>;
}

function Books({ offset = 0 }: { offset?: number }) {
  return <div className="books">{Array.from({ length: 8 }, (_, index) => <i className={`book book-${(index + offset) % 5}`} key={index} />)}</div>;
}

export function RoomDecor() {
  return (
    <div className="room-decor" aria-hidden="true">
      <div className="wall"><div className="wall-panels" /></div>
      <div className="wood-floor" /><div className="floor-trim" />
      <div className="string-lights"><span className="light-wire" />{Array.from({ length: 15 }, (_, index) => <i key={index} style={{ '--bulb-index': index, '--bulb-drop': `${Math.sin(index / 14 * Math.PI) * 35}px` } as CSSProperties} />)}</div>
      <div className="night-window">
        <div className="window-sky"><NightSky /></div>
        <span className="window-bar window-bar--vertical" /><span className="window-bar window-bar--horizontal" /><span className="window-sill" />
        <Plant className="window-plant" /><div className="sill-books"><Books offset={2} /></div>
      </div>
      <div className="wall-shelf"><Books /><Plant className="shelf-plant" /><span className="shelf-picture">☾</span></div>
      <div className="bookcase"><div className="bookcase-shelf"><Books offset={2} /></div><div className="bookcase-shelf"><span className="storage-box" /><Books offset={1} /></div><div className="bookcase-shelf"><Books offset={3} /></div><Plant className="bookcase-plant" /></div>
      <div className="wall-poster poster-kind"><span>good people<br />study hard things</span><b>♡</b></div>
      <div className="wall-poster poster-moon"><span className="poster-orbit" /><small>stay curious</small></div>
      <div className="pinned-note">you can<br />do it ♡</div>
      <div className="dreams-poster">same desk<br /><span>different dreams ♡</span></div>
      <Plant className="floor-plant" />
      <div className="floor-lamp"><span className="floor-lamp-glow" /><span className="floor-lamp-shade" /><span className="floor-lamp-stem" /><span className="floor-lamp-base" /></div>
      <div className="room-rug"><div className="rug-center">✧</div></div>
      <div className="floor-cushion" />
      <div className="sleeping-cat"><span className="cat-tail" /><span className="cat-body" /><span className="cat-head" /><span className="cat-sleep">z<span>z</span></span></div>
      <div className="floor-books"><i /><i /><i /></div>
      <div className="floor-tea" />
      <div className="knit-basket"><span /></div>
      <Plant className="foreground-plant" />
    </div>
  );
}
