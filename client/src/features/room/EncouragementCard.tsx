import { Heart } from 'lucide-react';

export function EncouragementCard() {
  return <section className="encouragement-card" aria-label="A little encouragement"><div className="encouragement-art" aria-hidden="true"><span className="encouragement-star star-one">✧</span><span className="encouragement-moon" /><span className="encouragement-star star-two">✦</span><span className="encouragement-star star-three">·</span><div className="little-book"><i /><i /></div></div><h2>Same stars.<br />Different dreams.</h2><p>A little progress every day adds up.<br />Glad you're here.</p><Heart size={14} /></section>;
}
