import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export type ClientLimits = {
  maxInFlightPerClient: number;
  writesPerMinute: number;
  writeBurst: number;
  newSessionsPerMinute: number;
  newSessionBurst: number;
  maxTrackedClients: number;
};

// A 4,000,000-event journal publishes in about 980 chunk requests; at ten
// writes per second it paces to under two minutes instead of failing. Starting
// uploads, observed sessions and direct records is rarer, so a shared classroom
// NAT can still start about thirty drafts at once.
export const DEFAULT_CLIENT_LIMITS: ClientLimits = {
  maxInFlightPerClient: 4,
  writesPerMinute: 600,
  writeBurst: 120,
  newSessionsPerMinute: 30,
  newSessionBurst: 30,
  maxTrackedClients: 50_000,
};

const SWEEP_INTERVAL_MS = 60_000;

export type Admission = { ok: true } | { ok: false; retryAfterSeconds: number };

type Bucket = { tokens: number; updatedAt: number };
type ClientState = { inFlight: number; writes: Bucket; newSessions: Bucket };

/** In-process per-client admission: concurrent requests plus write and new-session token buckets. */
export class ClientAdmission {
  readonly #limits: ClientLimits;
  readonly #now: () => number;
  readonly #clients = new Map<string, ClientState>();
  #lastSweep: number;

  constructor(limits: ClientLimits = DEFAULT_CLIENT_LIMITS, now: () => number = Date.now) {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive safe integer`);
    }
    this.#limits = limits;
    this.#now = now;
    this.#lastSweep = now();
  }

  get trackedClients(): number { return this.#clients.size; }

  enter(client: string, write: boolean): Admission {
    const state = this.#state(client);
    if (state.inFlight >= this.#limits.maxInFlightPerClient) return { ok: false, retryAfterSeconds: 1 };
    if (write) {
      const taken = this.#take(state.writes, this.#limits.writesPerMinute, this.#limits.writeBurst);
      if (!taken.ok) return taken;
    }
    state.inFlight++;
    return { ok: true };
  }

  leave(client: string): void {
    const state = this.#clients.get(client);
    if (state && state.inFlight > 0) state.inFlight--;
  }

  takeNewSession(client: string): Admission {
    return this.#take(this.#state(client).newSessions, this.#limits.newSessionsPerMinute, this.#limits.newSessionBurst);
  }

  #take(bucket: Bucket, perMinute: number, burst: number): Admission {
    const now = this.#now();
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.updatedAt) * perMinute / 60_000);
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) * 60 / perMinute)) };
  }

  #state(client: string): ClientState {
    const now = this.#now();
    if (now - this.#lastSweep >= SWEEP_INTERVAL_MS) this.#sweep(now);
    const existing = this.#clients.get(client);
    if (existing) return existing;
    if (this.#clients.size >= this.#limits.maxTrackedClients) this.#sweep(now);
    // Under a flood of distinct addresses, forget the oldest idle clients first.
    for (const [key, state] of this.#clients) {
      if (this.#clients.size < this.#limits.maxTrackedClients) break;
      if (state.inFlight === 0) this.#clients.delete(key);
    }
    const state = { inFlight: 0, writes: { tokens: this.#limits.writeBurst, updatedAt: now },
      newSessions: { tokens: this.#limits.newSessionBurst, updatedAt: now } };
    this.#clients.set(client, state);
    return state;
  }

  // A client with nothing in flight and full buckets is indistinguishable from a new one.
  #sweep(now: number): void {
    this.#lastSweep = now;
    const full = (bucket: Bucket, perMinute: number, burst: number) => bucket.tokens + (now - bucket.updatedAt) * perMinute / 60_000 >= burst;
    for (const [key, state] of this.#clients) {
      if (state.inFlight === 0 && full(state.writes, this.#limits.writesPerMinute, this.#limits.writeBurst)
        && full(state.newSessions, this.#limits.newSessionsPerMinute, this.#limits.newSessionBurst)) this.#clients.delete(key);
    }
  }
}

/**
 * The address limits apply to. A forwarded header is used only when the
 * operator names one set by a trusted proxy (for example Cloudflare's
 * cf-connecting-ip), and only when it holds exactly one address. IPv6 clients
 * are grouped by /64, the smallest block normally assigned to one subscriber.
 */
export function clientAddress(req: Pick<IncomingMessage, "headers" | "socket">, trustedHeader?: string): string {
  const forwarded = trustedHeader ? req.headers[trustedHeader.toLowerCase()] : undefined;
  const candidate = typeof forwarded === "string" && isIP(forwarded.trim()) ? forwarded.trim() : req.socket.remoteAddress;
  if (!candidate) return "unknown";
  const address = candidate.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return isIP(address) === 6 ? ipv6Prefix64(address) : address;
}

function ipv6Prefix64(address: string): string {
  const [head = "", tail] = address.split("%")[0]!.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
  return `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
}
