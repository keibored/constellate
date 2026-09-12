import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomScene } from '../../client/src/features/room/RoomScene.js';
import { MembersPanel } from '../../client/src/features/presence/MembersPanel.js';
import type { MemberPresence } from '../../shared/presence.js';
import { statusOptions } from '../../client/src/features/presence/statusOptions.js';

const mika: MemberPresence = { userId: 'view-user-mika', nickname: 'mika', avatar: 'pink', status: 'reading', connectedAt: 1, connected: true, deskId: 'desk-2' };

test('the room renders members at their server desk, leaves gaps intact, and keeps overflow guests off the three desks', () => {
  const members = [mika, { ...mika, userId: 'view-user-sam', nickname: 'sam', deskId: null }];
  const html = renderToStaticMarkup(createElement(RoomScene, { members, children: null }));
  assert.equal((html.match(/data-desk-id=/g) ?? []).length, 3);
  assert.equal((html.match(/empty desk/g) ?? []).length, 2);
  assert.match(html, /study-desk--slot-1[^>]+data-user-id="view-user-mika"[^>]+data-desk-id="desk-2"/);
  assert.match(html, /<strong>mika<\/strong>/);
  assert.match(html, /mika reading a book/);
  assert.doesNotMatch(html, /view-user-sam/);
});

test('the existing Members panel counts all guests, marks the current user, and offers retry only after an error', () => {
  const props = {
    members: [mika, { ...mika, userId: 'view-user-sam', nickname: 'sam', deskId: null, connected: false }],
    currentUserId: mika.userId, connection: 'connected' as const, error: null, statusError: null,
    onStatusChange: () => {}, onInvite: () => {}, onReconnect: () => {},
  };
  const html = renderToStaticMarkup(createElement(MembersPanel, props));
  assert.match(html, /count-badge">2<\/span>/);
  assert.match(html, /sam/);
  assert.equal((html.match(/class="you-label"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Reconnecting"/);
  for (const status of statusOptions) {
    assert.match(html, new RegExp(`<option value="${status.value}"[^>]*>${status.icon} ${status.label}<\\/option>`));
  }
  assert.match(html, /📖<\/span>Reading/);
  assert.doesNotMatch(html, />Reconnect<\/button>/);
  const failed = renderToStaticMarkup(createElement(MembersPanel, { ...props, connection: 'error', error: 'Cannot reach the room.' }));
  assert.match(failed, />Reconnect<\/button>/);
  assert.match(failed, /aria-label="Your status"[^>]*disabled/);
});
