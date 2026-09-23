import { apiUrl } from './api';
import { supabase } from './supabase';

export interface AccountRoom {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  createdAt: number;
  updatedAt: number;
}

async function request(path: string, init?: RequestInit) {
  const session = (await supabase?.auth.getSession())?.data.session;
  if (!session) throw new Error('Sign in to manage your rooms.');
  const response = await fetch(apiUrl(path), { ...init, headers: {
    Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...init?.headers,
  }});
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Account rooms are temporarily unavailable.');
  return body;
}

export async function listAccountRooms() {
  return (await request('/api/account/rooms') as { rooms: AccountRoom[] }).rooms;
}

export async function createAccountRoom(name: string) {
  return (await request('/api/account/rooms', { method: 'POST', body: JSON.stringify({ name }) }) as { room: AccountRoom }).room;
}
