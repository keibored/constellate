import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyRoomAction, freshRoom, members, RUNTIME_TIMING, voiceParticipants, type RuntimeAction } from '../src/redis/roomState.js';
import { parseVoiceSignal } from '../src/socket/voiceHandlers.js';
import { parseIceServers } from '../../client/src/features/voice/iceConfig.js';

const user = { id: 'voice-user-kei', nickname: 'kei', avatar: 'dark' as const };
test('voice is opt-in and one tab per guest; reconnect transfers only the same browser ownership and stale leave cannot remove it', () => {
  const room = freshRoom('demo', 0), clientId = randomUUID();
  const act = (action: RuntimeAction, at = 0) => applyRoomAction(room, action, at);
  act({ kind: 'join', user, owner: 'a', socketId: 'first' });
  assert.equal(voiceParticipants(room).participants.length, 0);
  assert.equal(act({ kind: 'voiceJoin', guestId: user.id, socketId: 'unknown', clientId, muted: false }).error, 'Rejoin this room before changing its state.');
  act({ kind: 'voiceJoin', guestId: user.id, socketId: 'first', clientId, muted: false });
  const original = room.voice[user.id].sessionId;
  act({ kind: 'voiceJoin', guestId: user.id, socketId: 'first', clientId, muted: false });
  assert.equal(room.voice[user.id].sessionId, original);
  act({ kind: 'join', user, owner: 'b', socketId: 'second' });
  assert.match(act({ kind: 'voiceJoin', guestId: user.id, socketId: 'second', clientId: randomUUID(), muted: false }).error!, /another tab/);
  assert.ok(act({ kind: 'voiceMute', guestId: user.id, socketId: 'second', sessionId: original, muted: true }).error);
  act({ kind: 'voiceJoin', guestId: user.id, socketId: 'second', clientId, muted: true });
  assert.notEqual(room.voice[user.id].sessionId, original);
  act({ kind: 'voiceLeave', guestId: user.id, socketId: 'first', clientId });
  assert.equal(voiceParticipants(room).participants.length, 1);
  assert.deepEqual(Object.keys(voiceParticipants(room).participants[0]).sort(), ['guestId', 'muted', 'nickname', 'sessionId']);
  act({ kind: 'voiceLeave', guestId: user.id, socketId: 'second', clientId });
  assert.equal(voiceParticipants(room).participants.length, 0); assert.equal(members(room).length, 1);
});

test('socket disconnect and lease expiry remove voice independently of the guest other tabs and study session', () => {
  const room = freshRoom('demo', 0), clientId = randomUUID();
  applyRoomAction(room, { kind: 'join', user, owner: 'a', socketId: 'voice' }, 0);
  applyRoomAction(room, { kind: 'join', user, owner: 'b', socketId: 'silent' }, 1000);
  const visit = room.study.visits[user.id].id;
  applyRoomAction(room, { kind: 'voiceJoin', guestId: user.id, socketId: 'voice', clientId, muted: false }, 1000);
  applyRoomAction(room, { kind: 'leave', guestId: user.id, socketId: 'voice', immediate: false }, 2000);
  assert.equal(voiceParticipants(room).participants.length, 0); assert.equal(members(room)[0].connected, true);
  assert.equal(room.study.visits[user.id].id, visit);
  applyRoomAction(room, { kind: 'voiceJoin', guestId: user.id, socketId: 'silent', clientId: randomUUID(), muted: false }, 3000);
  applyRoomAction(room, { kind: 'sweep' }, 1000 + RUNTIME_TIMING.lease);
  assert.equal(voiceParticipants(room).participants.length, 0); assert.equal(members(room).length, 1);
});

test('signaling accepts bounded audio SDP/ICE only and strips spoofed metadata; ICE configuration supports optional TURN', () => {
  const base = { roomId: 'demo', sessionId: randomUUID(), targetGuestId: 'voice-user-mika', targetSessionId: randomUUID(), negotiationId: randomUUID() };
  const offer = { ...base, description: { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }, fromGuestId: 'spoof' };
  assert.ok(parseVoiceSignal('voice:offer', offer));
  assert.equal('fromGuestId' in parseVoiceSignal('voice:offer', offer)!, false);
  assert.equal(parseVoiceSignal('voice:answer', offer), null);
  assert.equal(parseVoiceSignal('voice:offer', { ...offer, description: { type: 'offer', sdp: 'm=video 9 RTP/AVP 96' } }), null);
  assert.equal(parseVoiceSignal('voice:offer', { ...offer, description: { type: 'offer', sdp: 'x'.repeat(12001) } }), null);
  assert.equal(parseVoiceSignal('voice:ice-candidate', { ...base, candidate: { candidate: 'a', sdpMid: null, sdpMLineIndex: -1 } }), null);
  assert.ok(parseVoiceSignal('voice:ice-candidate', { ...base, candidate: { candidate: 'candidate:example', sdpMid: '0', sdpMLineIndex: 0 } }));
  assert.deepEqual(parseIceServers(), [{ urls: 'stun:stun.l.google.com:19302' }]);
  assert.deepEqual(parseIceServers('[]'), []);
  assert.deepEqual(parseIceServers('[{"urls":"turn:relay.example:3478","username":"temporary","credential":"example"}]')[0].urls, ['turn:relay.example:3478']);
  assert.throws(() => parseIceServers('[{"urls":"https://example.com"}]'));
  assert.throws(() => parseIceServers('broken'));
});
