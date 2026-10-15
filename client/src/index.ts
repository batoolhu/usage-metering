const BASE = process.env.SERVICE_URL ?? "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "change-me-admin-key";

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// بيستنى الخدمة لحد ما تكون جاهزة (مهم لما نشغّل كلشي بـ Docker Compose)
async function waitForService() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch {
      // لسا مش جاهزة
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`service is not reachable at ${BASE}`);
}

function step(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  await waitForService();
  const run = Date.now();

  // ---- تجهيز: حساب + خطة حساب صغيرة + مستخدمين بخطط مختلفة ----
  step("Setup");
  const acc = await call("POST", "/accounts", { "X-Admin-Key": ADMIN_KEY }, {
    name: `Acme Docs ${run}`,
  });
  const h = { "X-API-Key": acc.api_key };

  const accountPlan = await call("POST", "/v1/plans", h, {
    kind: "account", name: "Demo Account", monthly_allowance: 100, max_per_request: 50,
  });
  await call("PATCH", "/v1/account", h, { plan: "Demo Account" });
  await call("POST", "/v1/users", h, { external_id: "alice", plan: "Basic" });
  await call("POST", "/v1/users", h, { external_id: "bob", plan: "Premium" });
  console.log("  account plan: Demo Account (100 units/month, max 50 per request)");
  console.log("  alice: Basic (500/month, max 20 per request)");
  console.log("  bob:   Premium (5000/month, max 200 per request)");

  // ---- هاي هي "منطق التطبيق": كل مستند بيمر من هون، وما بنغيّر فيها شي ----
  let n = 0;
  async function processDocument(user: string, units: number) {
    n += 1;
    const r = await call("POST", "/v1/consume", h, {
      user_id: user, units, request_id: `doc-${run}-${n}`,
    });
    const verdict = r.accepted
      ? "ACCEPTED"
      : `REJECTED by ${r.rejected_by} (${r.rule}, limit ${r.limit})`;
    console.log(`  ${user} processes a ${units}-unit document -> ${verdict}`);
    console.log(
      `     ${user}: used ${r.user.consumed}, left ${r.user.remaining}` +
      ` | account: used ${r.account.consumed}, left ${r.account.remaining}`
    );
  }

  step("1. Accepted request");
  await processDocument("alice", 10);

  step("2. Rejected by a USER limit (alice is on Basic: max 20 per request)");
  await processDocument("alice", 25);

  step("3. Switch alice to Premium, then run the SAME action again");
  await call("PATCH", "/v1/users/alice", h, { plan: "Premium" });
  console.log("  alice's plan changed: Basic -> Premium");
  await processDocument("alice", 25);

  step("4. Bob uses most of the shared account allowance");
  await processDocument("bob", 30);
  await processDocument("bob", 30);

  step("5. Rejected by the ACCOUNT limit (bob has plenty left, the account does not)");
  await processDocument("bob", 20);

  step("6. Raise the account plan's allowance, then run the SAME action again");
  await call("PATCH", `/v1/plans/${accountPlan.id}`, h, { monthly_allowance: 500 });
  console.log("  account plan 'Demo Account' allowance: 100 -> 500");
  await processDocument("bob", 20);

  step("Final usage for this month");
  const usage = await call("GET", "/v1/account/usage", h);
  console.log(
    `  account: used ${usage.account.consumed} of ${usage.account.plan.monthly_allowance}`
  );
  for (const u of usage.users) {
    console.log(`  ${u.user_id} (${u.plan.name}): used ${u.consumed}, left ${u.remaining}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});