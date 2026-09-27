import assert from "node:assert/strict";
import test from "node:test";
import { ClientAdmission, DEFAULT_CLIENT_LIMITS, clientAddress } from "../apps/ingest-api/src/admission.ts";

const limits = { maxInFlightPerClient: 2, writesPerMinute: 60, writeBurst: 2, newSessionsPerMinute: 6, newSessionBurst: 1, maxTrackedClients: 100 };
function clock() { let now = 1_000_000; return { now: () => now, advance: ms => { now += ms; } }; }

test("write requests spend a per-client token bucket and report when to retry", () => {
  const time = clock(), admission = new ClientAdmission(limits, time.now);
  for (let i = 0; i < 2; i++) { assert.deepEqual(admission.enter("a", true), { ok: true }); admission.leave("a"); }
  assert.deepEqual(admission.enter("a", true), { ok: false, retryAfterSeconds: 1 });
  assert.deepEqual(admission.enter("b", true), { ok: true }, "clients have separate buckets");
  admission.leave("b");
  assert.deepEqual(admission.enter("a", false), { ok: true }, "reads do not spend write tokens");
  admission.leave("a");
  time.advance(999);
  assert.equal(admission.enter("a", true).ok, false);
  time.advance(1);
  assert.deepEqual(admission.enter("a", true), { ok: true });
});

test("each client has a bounded number of requests in flight", () => {
  const admission = new ClientAdmission({ ...limits, writeBurst: 100 }, clock().now);
  assert.equal(admission.enter("a", false).ok, true);
  assert.equal(admission.enter("a", true).ok, true);
  assert.deepEqual(admission.enter("a", false), { ok: false, retryAfterSeconds: 1 });
  assert.equal(admission.enter("b", false).ok, true);
  admission.leave("a");
  assert.equal(admission.enter("a", false).ok, true);
});

test("starting new sessions spends a separate, stricter bucket", () => {
  const time = clock(), admission = new ClientAdmission(limits, time.now);
  assert.deepEqual(admission.takeNewSession("a"), { ok: true });
  assert.deepEqual(admission.takeNewSession("a"), { ok: false, retryAfterSeconds: 10 });
  assert.deepEqual(admission.takeNewSession("b"), { ok: true });
  time.advance(10_000);
  assert.deepEqual(admission.takeNewSession("a"), { ok: true });
});

test("idle clients are forgotten and tracked clients stay bounded", () => {
  const time = clock(), admission = new ClientAdmission(limits, time.now);
  for (let i = 0; i < 1000; i++) { admission.enter(`c${i}`, true); admission.leave(`c${i}`); }
  assert.ok(admission.trackedClients <= limits.maxTrackedClients, `${admission.trackedClients} tracked`);
  admission.enter("busy", false);
  time.advance(120_000);
  admission.enter("fresh", true); admission.leave("fresh");
  assert.equal(admission.trackedClients, 2, "refilled idle clients are dropped; in-flight clients are kept");
  admission.leave("busy");
});

test("default limits allow a multi-million-event upload to pace instead of fail", () => {
  assert.ok(DEFAULT_CLIENT_LIMITS.writesPerMinute >= 600);
  assert.ok(DEFAULT_CLIENT_LIMITS.newSessionsPerMinute < DEFAULT_CLIENT_LIMITS.writesPerMinute);
  assert.ok(DEFAULT_CLIENT_LIMITS.maxInFlightPerClient >= 2);
});

test("client address uses the socket unless a trusted forwarding header is configured", () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(clientAddress(request("203.0.113.9", { "cf-connecting-ip": "198.51.100.1" })), "203.0.113.9");
  assert.equal(clientAddress(request("203.0.113.9", { "cf-connecting-ip": "198.51.100.1" }), "cf-connecting-ip"), "198.51.100.1");
  assert.equal(clientAddress(request("203.0.113.9", { "cf-connecting-ip": "198.51.100.1, 10.0.0.1" }), "cf-connecting-ip"), "203.0.113.9", "only a single address is trusted");
  assert.equal(clientAddress(request("203.0.113.9", {}), "cf-connecting-ip"), "203.0.113.9");
  assert.equal(clientAddress(request("::ffff:203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(request("2001:db8:1:2:aaaa::1")), "2001:db8:1:2::/64", "an IPv6 client is its /64");
  assert.equal(clientAddress(request("2001:db8:1:2:ffff:ffff:ffff:ffff")), "2001:db8:1:2::/64");
  assert.equal(clientAddress(request("2001:db8::1")), "2001:db8:0:0::/64");
  assert.equal(clientAddress(request(undefined)), "unknown");
});
