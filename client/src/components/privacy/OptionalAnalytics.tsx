import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { analyticsAllowed } from './ConsentBanner';

export function OptionalAnalytics() {
  const [enabled, setEnabled] = useState(analyticsAllowed);
  useEffect(() => {
    const update = () => setEnabled(analyticsAllowed());
    window.addEventListener('constellate:consent-changed', update);
    return () => window.removeEventListener('constellate:consent-changed', update);
  }, []);
  return enabled ? <Analytics /> : null;
}
