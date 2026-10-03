import { SiteFooter } from '../../components/layout/SiteFooter';

interface LegalPageProps { kind: 'privacy' | 'terms' }

export function LegalPage({ kind }: LegalPageProps) {
  const privacy = kind === 'privacy';
  return <div className="legal-shell">
    <header className="product-nav legal-nav">
      <a className="product-brand" href="/"><span className="brand-star" aria-hidden="true">✦</span><span>constellate</span></a>
      <a className="secondary-button" href="/">Back to dashboard</a>
    </header>
    <main className="legal-page">
      <p className="eyebrow">THE CLEAR, HUMAN VERSION</p>
      <h1>{privacy ? 'Privacy notice' : 'Terms of use'}</h1>
      <p className="legal-updated">Effective October 3, 2026</p>
      {privacy ? <>
        <section><h2>What Constellate stores</h2><p>We process account details you provide, such as your email address and profile nickname; room and task content; study-session activity; and technical information needed to keep rooms connected. Passwords are handled by Supabase Authentication and are not stored by Constellate’s application server.</p></section>
        <section><h2>Why we use it</h2><p>We use this information to authenticate you, create and synchronize study rooms, restore sessions, show study statistics, prevent abuse, and operate the service securely.</p></section>
        <section><h2>Browser storage and analytics</h2><p>Essential browser storage remembers your session, recent room, display preferences, and privacy choice. Optional analytics is disabled unless you choose to allow it. You can reopen Privacy settings from the footer at any time.</p></section>
        <section><h2>Service providers</h2><p>Constellate currently relies on Supabase for authentication and database services, Render for the real-time API, and Vercel for the web application. These providers process limited data needed to deliver their services.</p></section>
        <section><h2>Your choices</h2><p>You may use guest mode for many room features, sign out at any time, decline optional analytics, or request correction or deletion of account-linked application data through the project owner.</p></section>
        <section><h2>Retention and security</h2><p>Data is retained while needed to operate the service or meet legitimate security requirements. We use encrypted HTTPS connections, restricted secrets, validation, and rate limits, but no internet service can promise absolute security.</p></section>
      </> : <>
        <section><h2>Using Constellate</h2><p>You may use Constellate for lawful personal and collaborative study. Keep your account secure and do not attempt to disrupt rooms, bypass access controls, scrape private content, impersonate others, or use the service to harass people.</p></section>
        <section><h2>Your content</h2><p>You keep ownership of content you submit. You give Constellate permission to store, process, and display it only as needed to provide room, task, chat, profile, and study-history features.</p></section>
        <section><h2>Voice and shared rooms</h2><p>Voice is optional and requires browser permission. Treat shared-room links as invitations: anyone with access to a public link may join, while private-room links should not be posted publicly.</p></section>
        <section><h2>Availability</h2><p>Constellate is an evolving student project. Features may change, experience interruptions, or contain errors. Important academic work should be kept in a separate, reliable copy.</p></section>
        <section><h2>Enforcement and changes</h2><p>Access may be limited when reasonably necessary to protect users or the service. Material updates to these terms will be reflected by the effective date on this page.</p></section>
      </>}
    </main>
    <SiteFooter />
  </div>;
}
