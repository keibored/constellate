import { randomBytes } from 'node:crypto';
interface Scope { socketId: string; roomId: string; guestId: string; token: string }
/** Short-lived capabilities; never a public guest-ID query parameter. */
export class StatsAccess {
  private tokens = new Map<string, Scope>();
  private sockets = new Map<string, Scope>();
  grant(socketId: string, roomId: string, guestId: string) {
    const previous = this.sockets.get(socketId);
    if (previous?.roomId === roomId && previous.guestId === guestId) return previous.token;
    this.revoke(socketId);
    const scope = { socketId, roomId, guestId, token: randomBytes(32).toString('base64url') };
    this.tokens.set(scope.token, scope); this.sockets.set(socketId, scope);
    return scope.token;
  }
  resolve(token: string) { return this.tokens.get(token); }
  revoke(socketId: string) {
    const previous = this.sockets.get(socketId);
    if (previous) this.tokens.delete(previous.token);
    this.sockets.delete(socketId);
  }
}
