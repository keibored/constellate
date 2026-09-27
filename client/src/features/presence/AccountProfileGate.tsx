import { LoaderCircle, RefreshCw } from 'lucide-react';

export function AccountProfileGate({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) {
  if (!loading && !error) return null;
  return <div className="profile-gate" role={error ? 'alert' : 'status'} aria-live="polite">
    <div className="profile-gate-card">
      <span className="profile-gate-star" aria-hidden="true">✦</span>
      {loading ? <>
        <LoaderCircle className="profile-gate-spinner" size={23} aria-hidden="true" />
        <h2>Finding your place…</h2>
        <p>Loading the profile connected to your account.</p>
      </> : <>
        <h2>We couldn’t load your profile</h2>
        <p>{error}</p>
        <button className="primary-button" onClick={onRetry}><RefreshCw size={15} />Try again</button>
      </>}
    </div>
  </div>;
}
