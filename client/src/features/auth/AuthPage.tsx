import { useState, type FormEvent } from 'react';
import { supabase } from '../../services/supabase';
import { useAuth } from './AuthProvider';

export function AuthPage() {
  const { configured, user } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  if (user) return <main className="product-page"><section className="product-card auth-card"><span className="brand-star">✦</span><h1>You are signed in.</h1><p>Your Constellate account is ready.</p><a className="primary-button" href="/">Open dashboard</a></section></main>;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setMessage(null);
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) { setMessage('Enter a valid email address.'); return; }
    if (password.length < 8) { setMessage('Use at least 8 characters for your password.'); return; }
    if (mode === 'signup' && !accepted) { setMessage('Please accept the Terms and Privacy Notice to create an account.'); return; }
    setBusy(true);
    if (!supabase) { setMessage('Account sign-in is not configured yet. Guest rooms still work.'); setBusy(false); return; }
    const result = mode === 'signup'
      ? await supabase.auth.signUp({ email: normalizedEmail, password, options: { emailRedirectTo: `${window.location.origin}/` } })
      : await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
    setBusy(false);
    if (result.error) setMessage(result.error.message);
    else if (mode === 'signup' && !result.data.session) setMessage('Check your email to confirm your account.');
    else window.location.assign('/');
  };
  return <main className="product-page"><section className="product-card auth-card">
    <a className="product-brand" href="/"><span className="brand-star">✦</span><span>constellate</span></a>
    <p className="eyebrow">YOUR STUDY UNIVERSE</p><h1>{mode === 'signin' ? 'Welcome back.' : 'Create your account.'}</h1>
    <p className="product-copy">Create your Constellate account. Room ownership and synced history are the next v2 milestone.</p>
    {!configured && <p className="product-notice">Account setup is being connected. You can continue using guest rooms.</p>}
    <form className="auth-form" onSubmit={submit}>
      <label htmlFor="auth-email">Email</label><input id="auth-email" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" required maxLength={254} aria-invalid={Boolean(message)} value={email} onChange={event => { setEmail(event.target.value); setMessage(null); }} />
      <label htmlFor="auth-password">Password</label><input id="auth-password" type="password" minLength={8} maxLength={128} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required aria-invalid={Boolean(message)} value={password} onChange={event => { setPassword(event.target.value); setMessage(null); }} />
      {mode === 'signup' && <label className="legal-check"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /> <span>I agree to the <a href="/terms">Terms</a> and acknowledge the <a href="/privacy">Privacy Notice</a>.</span></label>}
      {message && <p className="join-error" role="alert">{message}</p>}
      <button className="primary-button" disabled={busy || !configured || (mode === 'signup' && !accepted)}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
    </form>
    <button className="text-button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setMessage(null); setAccepted(false); }}>{mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}</button>
    <a className="guest-link" href="/join">Continue as guest</a>
  </section></main>;
}
