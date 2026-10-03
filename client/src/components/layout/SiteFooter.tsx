export function SiteFooter() {
  return <footer className="site-footer">
    <p>© {new Date().getFullYear()} Constellate · study together, further</p>
    <nav aria-label="Legal and support">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <button type="button" onClick={() => window.dispatchEvent(new Event('constellate:privacy-settings'))}>Privacy settings</button>
    </nav>
  </footer>;
}
