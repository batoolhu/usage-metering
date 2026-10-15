import { describe, it, expect, afterAll } from "vitest";
import { api, newAccount, setup } from "./helpers";
import { pool } from "../src/db";

afterAll(async () => {
  await pool.end();
});

const consume = (h: Record<string, string>, user: string, units: number, id: string) =>
  api("POST", "/v1/consume", h, { user_id: user, units, request_id: id });

async function planId(h: Record<string, string>, name: string): Promise<number> {
  const r = await api("GET", "/v1/plans", h);
  return r.json.find((p: any) => p.name === name).id;
}

describe("plan changes", () => {
  it("switching a user's plan keeps consumed units and gives no fresh allowance", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 20, max: 20 } });
    const first = await consume(h, "u", 20, "r1");
    expect(first.json.user.remaining).toBe(0);

    await api("POST", "/v1/plans", h, {
      kind: "user", name: "Bigger", monthly_allowance: 30, max_per_request: 20,
    });
    await api("PATCH", "/v1/users/u", h, { plan: "Bigger" });

    const usage = await api("GET", "/v1/users/u/usage", h);
    expect(usage.json.consumed).toBe(20);
    expect(usage.json.remaining).toBe(10);

    const tooMuch = await consume(h, "u", 11, "r2");
    expect(tooMuch.json).toMatchObject({
      accepted: false, rejected_by: "user", rule: "monthly_allowance",
    });
    const ok = await consume(h, "u", 10, "r3");
    expect(ok.json.accepted).toBe(true);
  });

  it("switching the account's plan keeps consumed units", async () => {
    const h = await setup({ allowance: 100, max: 50 }, { u: { allowance: 1000, max: 50 } });
    await consume(h, "u", 50, "r1");
    await consume(h, "u", 50, "r2");
    const blocked = await consume(h, "u", 10, "r3");
    expect(blocked.json).toMatchObject({ accepted: false, rejected_by: "account" });

    await api("POST", "/v1/plans", h, {
      kind: "account", name: "Bigger", monthly_allowance: 300, max_per_request: 50,
    });
    await api("PATCH", "/v1/account", h, { plan: "Bigger" });

    const usage = await api("GET", "/v1/account/usage", h);
    expect(usage.json.account.consumed).toBe(100);
    expect(usage.json.account.remaining).toBe(200);
    const ok = await consume(h, "u", 50, "r4");
    expect(ok.json.accepted).toBe(true);
  });

  it("updating a custom plan takes effect immediately for all its users", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, {});
    const p = await api("POST", "/v1/plans", h, {
      kind: "user", name: "Shared", monthly_allowance: 50, max_per_request: 10,
    });
    await api("POST", "/v1/users", h, { external_id: "a", plan: "Shared" });
    await api("POST", "/v1/users", h, { external_id: "b", plan: "Shared" });

    expect((await consume(h, "a", 20, "r1")).json).toMatchObject({
      accepted: false, rule: "max_per_request",
    });

    await api("PATCH", `/v1/plans/${p.json.id}`, h, { max_per_request: 30 });

    expect((await consume(h, "a", 20, "r2")).json.accepted).toBe(true);
    expect((await consume(h, "b", 20, "r3")).json.accepted).toBe(true);
  });

  it("users sharing a plan keep separate usage totals", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, {});
    await api("POST", "/v1/plans", h, {
      kind: "user", name: "Shared", monthly_allowance: 50, max_per_request: 50,
    });
    await api("POST", "/v1/users", h, { external_id: "a", plan: "Shared" });
    await api("POST", "/v1/users", h, { external_id: "b", plan: "Shared" });

    expect((await consume(h, "a", 30, "r1")).json.accepted).toBe(true);
    expect((await consume(h, "b", 30, "r2")).json.accepted).toBe(true);

    const a = await api("GET", "/v1/users/a/usage", h);
    const b = await api("GET", "/v1/users/b/usage", h);
    expect(a.json.consumed).toBe(30);
    expect(b.json.consumed).toBe(30);
    const acc = await api("GET", "/v1/account/usage", h);
    expect(acc.json.account.consumed).toBe(60);
  });

  it("lowering the allowance below usage shows 0 remaining and rejects until raised", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 50 } });
    await consume(h, "u", 50, "r1");
    await consume(h, "u", 30, "r2");
    const id = await planId(h, "P-u");

    await api("PATCH", `/v1/plans/${id}`, h, { monthly_allowance: 50 });
    const usage = await api("GET", "/v1/users/u/usage", h);
    expect(usage.json.consumed).toBe(80);
    expect(usage.json.remaining).toBe(0);

    const blocked = await consume(h, "u", 1, "r3");
    expect(blocked.json).toMatchObject({
      accepted: false, rejected_by: "user", rule: "monthly_allowance",
    });
    expect(blocked.json.user.consumed).toBe(80);

    await api("PATCH", `/v1/plans/${id}`, h, { monthly_allowance: 200 });
    const usage2 = await api("GET", "/v1/users/u/usage", h);
    expect(usage2.json.remaining).toBe(120);
    expect((await consume(h, "u", 1, "r4")).json.accepted).toBe(true);
  });

  it("rejected requests stay in history after a plan change", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 10 } });
    await consume(h, "u", 50, "big");
    const id = await planId(h, "P-u");
    await api("PATCH", `/v1/plans/${id}`, h, { max_per_request: 100 });
    const hist = await api("GET", "/v1/requests", h);
    const item = hist.json.items.find((i: any) => i.request_id === "big");
    expect(item).toMatchObject({ accepted: false, rejected_by: "user", rule: "max_per_request" });
  });
});

describe("months", () => {
  it("previous months stay available and do not affect the current month", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 50 } });
    const acc = await api("GET", "/v1/account", h);
    const accountId = acc.json.id;
    const u = await pool.query(
      "SELECT id FROM users WHERE account_id = $1 AND external_id = 'u'",
      [accountId]
    );
    const userId = u.rows[0].id;

    await pool.query(
      "INSERT INTO account_usage (account_id, month, consumed) VALUES ($1, '2026-09-01', 40)",
      [accountId]
    );
    await pool.query(
      "INSERT INTO user_usage (user_id, month, consumed) VALUES ($1, '2026-09-01', 25)",
      [userId]
    );
    await pool.query(
      `INSERT INTO requests (account_id, user_id, request_id, units, accepted, month)
       VALUES ($1, $2, 'old-1', 25, true, '2026-09-01')`,
      [accountId, userId]
    );

    const past = await api("GET", "/v1/account/usage?month=2026-09", h);
    expect(past.json.month).toBe("2026-09");
    expect(past.json.account.consumed).toBe(40);
    expect(past.json.users[0].consumed).toBe(25);

    const pastUser = await api("GET", "/v1/users/u/usage?month=2026-09", h);
    expect(pastUser.json.consumed).toBe(25);

    const now = await api("GET", "/v1/users/u/usage", h);
    expect(now.json.consumed).toBe(0);
    expect(now.json.remaining).toBe(100);

    const hist = await api("GET", "/v1/requests?month=2026-09", h);
    expect(hist.json.items.map((i: any) => i.request_id)).toEqual(["old-1"]);
  });

  it("rejects a malformed month", async () => {
    const h = await newAccount();
    expect((await api("GET", "/v1/account/usage?month=2026-13", h)).status).toBe(400);
    expect((await api("GET", "/v1/requests?month=abc", h)).status).toBe(400);
  });
});

describe("history pagination", () => {
  it("returns newest first, in pages, without duplicates", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 50 } });
    for (let i = 0; i < 5; i++) await consume(h, "u", 1, `r${i}`);

    const p1 = await api("GET", "/v1/requests?limit=2", h);
    expect(p1.json.items.map((i: any) => i.request_id)).toEqual(["r4", "r3"]);
    expect(p1.json.next_cursor).not.toBeNull();

    const p2 = await api("GET", `/v1/requests?limit=2&cursor=${p1.json.next_cursor}`, h);
    expect(p2.json.items.map((i: any) => i.request_id)).toEqual(["r2", "r1"]);

    const p3 = await api("GET", `/v1/requests?limit=2&cursor=${p2.json.next_cursor}`, h);
    expect(p3.json.items.map((i: any) => i.request_id)).toEqual(["r0"]);
    expect(p3.json.next_cursor).toBeNull();
  });

  it("rejects an invalid cursor or limit", async () => {
    const h = await newAccount();
    expect((await api("GET", "/v1/requests?cursor=abc", h)).status).toBe(400);
    expect((await api("GET", "/v1/requests?limit=0", h)).status).toBe(400);
    expect((await api("GET", "/v1/requests?limit=1000", h)).status).toBe(400);
  });
});

describe("concurrency", () => {
  it("never lets the account exceed its allowance", async () => {
    const users: Record<string, { allowance: number; max: number }> = {};
    for (let i = 0; i < 5; i++) users[`u${i}`] = { allowance: 1000, max: 10 };
    const h = await setup({ allowance: 100, max: 10 }, users);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => consume(h, `u${i % 5}`, 5, `c-${i}`))
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const accepted = results.filter((r) => r.json.accepted).length;
    expect(accepted).toBe(20);
    results
      .filter((r) => !r.json.accepted)
      .forEach((r) =>
        expect(r.json).toMatchObject({ rejected_by: "account", rule: "monthly_allowance" })
      );

    const usage = await api("GET", "/v1/account/usage", h);
    expect(usage.json.account.consumed).toBe(100);
    expect(usage.json.account.remaining).toBe(0);
    const sum = usage.json.users.reduce((s: number, u: any) => s + u.consumed, 0);
    expect(sum).toBe(100);
  });

  it("never lets one user exceed their allowance", async () => {
    const h = await setup({ allowance: 10000, max: 100 }, { u: { allowance: 50, max: 10 } });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => consume(h, "u", 5, `c-${i}`))
    );
    expect(results.filter((r) => r.json.accepted).length).toBe(10);
    const usage = await api("GET", "/v1/users/u/usage", h);
    expect(usage.json.consumed).toBe(50);
  });

  it("the same request_id sent 20 times at once is counted once", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 50 } });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consume(h, "u", 7, "same"))
    );
    expect(results.every((r) => r.status === 200 && r.json.accepted)).toBe(true);
    expect(results.filter((r) => r.json.replayed === false).length).toBe(1);
    const usage = await api("GET", "/v1/users/u/usage", h);
    expect(usage.json.consumed).toBe(7);
  });
});