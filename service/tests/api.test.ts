import { describe, it, expect } from "vitest";
import { api, newAccount, setup } from "./helpers";

describe("API key auth", () => {
  it("rejects a missing key", async () => {
    const r = await api("GET", "/v1/account");
    expect(r.status).toBe(401);
  });

  it("rejects an invalid key", async () => {
    const r = await api("GET", "/v1/account", { "X-API-Key": "mk_wrong" });
    expect(r.status).toBe(401);
  });

  it("accepts a valid key", async () => {
    const h = await newAccount();
    const r = await api("GET", "/v1/account", h);
    expect(r.status).toBe(200);
    expect(r.json.plan).toBe("Starter");
  });
});

describe("account isolation", () => {
  it("another account cannot see or use my user", async () => {
    await setup({ allowance: 1000, max: 100 }, { alice: { allowance: 100, max: 20 } });
    const other = await newAccount();
    expect((await api("GET", "/v1/users/alice", other)).status).toBe(404);
    expect((await api("GET", "/v1/users/alice/usage", other)).status).toBe(404);
    const c = await api("POST", "/v1/consume", other, {
      user_id: "alice", units: 1, request_id: "x",
    });
    expect(c.status).toBe(404);
  });

  it("another account cannot edit my custom plan", async () => {
    const mine = await newAccount();
    const p = await api("POST", "/v1/plans", mine, {
      kind: "user", name: "Mine", monthly_allowance: 10, max_per_request: 5,
    });
    const other = await newAccount();
    const r = await api("PATCH", `/v1/plans/${p.json.id}`, other, { monthly_allowance: 1 });
    expect(r.status).toBe(404);
    const list = await api("GET", "/v1/plans", other);
    expect(list.json.some((x: any) => x.name === "Mine")).toBe(false);
  });

  it("history shows only my own requests", async () => {
    const a = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 20 } });
    await api("POST", "/v1/consume", a, { user_id: "u", units: 1, request_id: "r1" });
    const other = await newAccount();
    const r = await api("GET", "/v1/requests", other);
    expect(r.json.items).toEqual([]);
  });
});

describe("predefined plans", () => {
  it("are read-only", async () => {
    const h = await newAccount();
    const plans = await api("GET", "/v1/plans", h);
    const starter = plans.json.find((p: any) => p.name === "Starter");
    const r = await api("PATCH", `/v1/plans/${starter.id}`, h, { monthly_allowance: 1 });
    expect(r.status).toBe(403);
  });
});

describe("consume: examples from the brief", () => {
  it("25 units is rejected by the user's per-request limit", async () => {
    const h = await setup({ allowance: 10000, max: 100 }, { u: { allowance: 1000, max: 20 } });
    const r = await api("POST", "/v1/consume", h, { user_id: "u", units: 25, request_id: "r1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      accepted: false, rejected_by: "user", rule: "max_per_request",
    });
    expect(r.json.user.consumed).toBe(0);
    expect(r.json.account.consumed).toBe(0);
  });

  it("10 units is accepted and counts for both user and account", async () => {
    const h = await setup({ allowance: 10000, max: 100 }, { u: { allowance: 1000, max: 20 } });
    const r = await api("POST", "/v1/consume", h, { user_id: "u", units: 10, request_id: "r1" });
    expect(r.json.accepted).toBe(true);
    expect(r.json.user).toEqual({ consumed: 10, remaining: 990 });
    expect(r.json.account).toEqual({ consumed: 10, remaining: 9990 });
  });

  it("is rejected by the account when it has only 5 units left", async () => {
    const h = await setup({ allowance: 15, max: 100 }, { u: { allowance: 1000, max: 20 } });
    await api("POST", "/v1/consume", h, { user_id: "u", units: 10, request_id: "r1" });
    const r = await api("POST", "/v1/consume", h, { user_id: "u", units: 10, request_id: "r2" });
    expect(r.json).toMatchObject({
      accepted: false, rejected_by: "account", rule: "monthly_allowance",
    });
    expect(r.json.user.consumed).toBe(10);
    expect(r.json.account.consumed).toBe(10);
  });
});

describe("consume: validation", () => {
  it("rejects bad units, missing ids and unknown users", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 20 } });
    const bad = [0, -5, 1.5, "5", null];
    for (const units of bad) {
      const r = await api("POST", "/v1/consume", h, { user_id: "u", units, request_id: "v" });
      expect(r.status).toBe(400);
    }
    expect((await api("POST", "/v1/consume", h, { units: 1, request_id: "v" })).status).toBe(400);
    expect((await api("POST", "/v1/consume", h, { user_id: "u", units: 1 })).status).toBe(400);
    expect(
      (await api("POST", "/v1/consume", h, { user_id: "nobody", units: 1, request_id: "v" })).status
    ).toBe(404);
  });
});

describe("consume: retries", () => {
  it("the same request_id is counted once and returns the same decision", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 20 } });
    const first = await api("POST", "/v1/consume", h, { user_id: "u", units: 10, request_id: "same" });
    const again = await api("POST", "/v1/consume", h, { user_id: "u", units: 10, request_id: "same" });
    expect(first.json.replayed).toBe(false);
    expect(again.json.replayed).toBe(true);
    expect(again.json.accepted).toBe(true);
    expect(again.json.user.consumed).toBe(10);
  });

  it("a rejected request replays the same rejection", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 20 } });
    await api("POST", "/v1/consume", h, { user_id: "u", units: 50, request_id: "big" });
    const again = await api("POST", "/v1/consume", h, { user_id: "u", units: 50, request_id: "big" });
    expect(again.json).toMatchObject({ accepted: false, replayed: true, rejected_by: "user" });
  });

  it("the same request_id with different units is a 409", async () => {
    const h = await setup({ allowance: 1000, max: 100 }, { u: { allowance: 100, max: 20 } });
    await api("POST", "/v1/consume", h, { user_id: "u", units: 10, request_id: "same" });
    const r = await api("POST", "/v1/consume", h, { user_id: "u", units: 15, request_id: "same" });
    expect(r.status).toBe(409);
  });
});