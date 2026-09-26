import type { AvatarId } from '../../../shared/presence';
import { apiUrl } from './api';
import { supabase } from './supabase';

export interface AccountProfile { nickname: string; avatar: AvatarId; updatedAt: number }

async function request(init?: RequestInit) {
  const session = (await supabase?.auth.getSession())?.data.session;
  if (!session) throw new Error('Sign in to manage your profile.');
  const response = await fetch(apiUrl('/api/account/profile'), { ...init, headers: {
    Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...init?.headers,
  }});
  const body = await response.json().catch(() => ({})) as { error?: string; profile?: AccountProfile };
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(body.error ?? 'Your profile is temporarily unavailable.');
  return body.profile ?? null;
}

export function getAccountProfile() { return request(); }

export async function saveAccountProfile(nickname: string, avatar: AvatarId) {
  const profile = await request({ method: 'PUT', body: JSON.stringify({ nickname, avatar }) });
  if (!profile) throw new Error('Your profile could not be saved.');
  return profile;
}
