export interface AccountIdentity { id: string; email?: string }
export interface AccountVerifier { verify(token: string): Promise<AccountIdentity | null> }

export class SupabaseAccountVerifier implements AccountVerifier {
  constructor(private url: string, private publishableKey: string) {}

  async verify(token: string): Promise<AccountIdentity | null> {
    if (!token || token.length > 4096) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${this.url}/auth/v1/user`, { headers: {
        Authorization: `Bearer ${token}`, apikey: this.publishableKey,
      }, signal: controller.signal });
      if (!response.ok) return null;
      const value = await response.json() as { id?: unknown; email?: unknown };
      return typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id)
        ? { id: value.id, ...(typeof value.email === 'string' ? { email: value.email } : {}) } : null;
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
}

export function bearerToken(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header ?? '');
  return match?.[1] ?? null;
}
