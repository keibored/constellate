import { useEffect } from 'react';

interface PageMetaProps { title: string; description: string; noIndex?: boolean }

function setMeta(selector: string, attribute: 'content' | 'href', value: string) {
  document.head.querySelector(selector)?.setAttribute(attribute, value);
}

export function PageMeta({ title, description, noIndex = false }: PageMetaProps) {
  useEffect(() => {
    document.title = title;
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', description);
    setMeta('meta[property="og:url"]', 'content', window.location.href);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', description);
    setMeta('link[rel="canonical"]', 'href', window.location.href.split(/[?#]/)[0]);
    setMeta('meta[name="robots"]', 'content', noIndex ? 'noindex, nofollow' : 'index, follow');
  }, [description, noIndex, title]);
  return null;
}
