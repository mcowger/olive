import { randomUUID } from "node:crypto";

const AUTH_SESSION_TTL_MS = 5 * 60 * 1000;

interface PlaudAuthSession {
  verifier: string;
  state: string;
  expiresAt: number;
}

export class PlaudAuthSessionStore {
  private readonly sessions = new Map<string, PlaudAuthSession>();

  create(session: Omit<PlaudAuthSession, "expiresAt">, now = Date.now()): string {
    this.removeExpired(now);
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { ...session, expiresAt: now + AUTH_SESSION_TTL_MS });
    return sessionId;
  }

  get(sessionId: string, now = Date.now()): PlaudAuthSession | undefined {
    this.removeExpired(now);
    return this.sessions.get(sessionId);
  }

  consume(sessionId: string, now = Date.now()): PlaudAuthSession | undefined {
    this.removeExpired(now);
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    this.sessions.delete(sessionId);
    return session;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private removeExpired(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
