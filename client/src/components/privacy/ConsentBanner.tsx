import { useEffect, useState } from 'react';

const STORAGE_KEY = 'constellate_privacy_choice_v1';

type Choice = 'essential' | 'analytics';

export function analyticsAllowed() {
  return localStorage.getItem(STORAGE_KEY) === 'analytics';
}

export function ConsentBanner() {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('constellate:privacy-settings', show);
    return () => window.removeEventListener('constellate:privacy-settings', show);
  }, []);

  const choose = (choice: Choice) => {
    localStorage.setItem(STORAGE_KEY, choice);
    window.dispatchEvent(new CustomEvent('constellate:consent-changed', { detail: choice }));
    setOpen(false);
  };

  if (!open) return null;
  return <section className="consent-banner" aria-labelledby="privacy-choice-title">
    <div>
      <h2 id="privacy-choice-title">Your space, your choice.</h2>
      <p>Constellate uses essential browser storage for sign-in, room recovery, and preferences. Optional, privacy-friendly analytics will run only if you allow it. <a href="/privacy">Read our privacy notice</a>.</p>
    </div>
    <div className="consent-actions">
      <button className="secondary-button" type="button" onClick={() => choose('essential')}>Essential only</button>
      <button className="primary-button" type="button" onClick={() => choose('analytics')}>Allow analytics</button>
    </div>
  </section>;
}
