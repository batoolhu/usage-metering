const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "change-me-admin-key";

type Hdrs = Record<string, string>;

async function api(method: string, path: string, headers: Hdrs, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function newAccount(label: string): Promise<Hdrs> {
  const r = await api("POST", "/accounts", { "X-Admin-Key": ADMIN_KEY }, {
    name: `${label}-${Date.now()}`,
  });
  return { "X-API-Key": r.json.api_key };
}

// اختبار 1: 50 طلب مختلف بنفس اللحظة، والحساب حده 100 فقط
async function testDistinctRequests(): Promise<boolean> {
  const h = await newAccount("conc");
  await api("POST", "/v1/plans", h, {
    kind: "account", name: "Conc", monthly_allowance: 100, max_per_request: 10,
  });
  await api("PATCH", "/v1/account", h, { plan: "Conc" });
  for (let i = 0; i < 5; i++) {
    await api("POST", "/v1/users", h, { external_id: `u${i}`, plan: "Premium" });
  }

  const N = 50;
  const UNITS = 5;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api("POST", "/v1/consume", h, {
        user_id: `u${i % 5}`, units: UNITS, request_id: `r-${i}`,
      })
    )
  );

  const errors = results.filter((r) => r.status !== 200).length;
  const accepted = results.filter((r) => r.json.accepted === true).length;
  const rejected = results.filter((r) => r.json.accepted === false);
  const wrongReason = rejected.filter(
    (r) => r.json.rejected_by !== "account" || r.json.rule !== "monthly_allowance"
  ).length;

  console.log("\n--- Test 1: concurrent distinct requests ---");
  console.log(`requests: ${N} x ${UNITS} units, account allowance: 100`);
  console.log(`accepted: ${accepted} (expected 20)`);
  console.log(`rejected: ${rejected.length} (expected 30)`);
  console.log(`rejected for the wrong reason: ${wrongReason} (expected 0)`);
  console.log(`HTTP errors: ${errors} (expected 0)`);

  return errors === 0 && accepted === 20 && rejected.length === 30 && wrongReason === 0;
}

// اختبار 2: نفس request_id انبعت 20 مرة بنفس اللحظة
async function testSameRequestId(): Promise<boolean> {
  const h = await newAccount("retry");
  await api("POST", "/v1/users", h, { external_id: "u", plan: "Premium" });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      api("POST", "/v1/consume", h, { user_id: "u", units: 7, request_id: "same" })
    )
  );

  const errors = results.filter((r) => r.status !== 200).length;
  const allAccepted = results.every((r) => r.json.accepted === true);
  const fresh = results.filter((r) => r.json.replayed === false).length;
  const consumedValues = new Set(results.map((r) => r.json.user?.consumed));

  console.log("\n--- Test 2: same request_id sent 20 times at once ---");
  console.log(`all accepted: ${allAccepted} (expected true)`);
  console.log(`processed as new: ${fresh} (expected 1)`);
  console.log(`consumed values seen: ${[...consumedValues].join(",")} (expected 7)`);
  console.log(`HTTP errors: ${errors} (expected 0)`);

  return errors === 0 && allAccepted && fresh === 1 &&
    consumedValues.size === 1 && consumedValues.has(7);
}

async function main() {
  const ok1 = await testDistinctRequests();
  const ok2 = await testSameRequestId();
  console.log(`\nTest 1: ${ok1 ? "PASS" : "FAIL"}`);
  console.log(`Test 2: ${ok2 ? "PASS" : "FAIL"}`);
  process.exit(ok1 && ok2 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});