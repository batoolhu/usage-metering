const BASE = process.env.SERVICE_URL ?? "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "change-me-admin-key";
const SCENARIO = process.argv[2] ?? "hot";
const TOTAL = Number(process.env.TOTAL ?? 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const RUN = Date.now();

type Hdrs = Record<string, string>;

async function api(method: string, path: string, headers: Hdrs, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

interface Acc {
  h: Hdrs;
  users: string[];
  allowance: number;
  acceptedUnits: number;
}

async function makeAccount(label: string, allowance: number, userCount: number): Promise<Acc> {
  const r = await api("POST", "/accounts", { "X-Admin-Key": ADMIN_KEY }, {
    name: `${label}-${RUN}-${Math.random().toString(36).slice(2, 7)}`,
  });
  const h = { "X-API-Key": r.json.api_key };
  await api("POST", "/v1/plans", h, {
    kind: "account", name: "Perf", monthly_allowance: allowance, max_per_request: 10,
  });
  await api("PATCH", "/v1/account", h, { plan: "Perf" });

  const users = Array.from({ length: userCount }, (_, i) => `u${i}`);
  for (let i = 0; i < users.length; i += 20) {
    await Promise.all(
      users.slice(i, i + 20).map((u) =>
        api("POST", "/v1/users", h, { external_id: u, plan: "Premium" })
      )
    );
  }
  
  return { h, users, allowance, acceptedUnits: 0 };
}

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  console.log(`scenario=${SCENARIO} total=${TOTAL} concurrency=${CONCURRENCY}`);

  let accounts: Acc[];
  let expectedAccepted: number | null = null;
  if (SCENARIO === "hot") {
    accounts = [await makeAccount("hot", 3000, 200)];
    expectedAccepted = Math.min(TOTAL, 3000);
  } else if (SCENARIO === "many") {
    accounts = [];
    for (let i = 0; i < 20; i++) accounts.push(await makeAccount(`many${i}`, 1_000_000, 10));
    expectedAccepted = TOTAL;
  } else {
    throw new Error("scenario must be 'hot' or 'many'");
  }

  const latencies: number[] = [];
  let accepted = 0, rejected = 0, errors = 0, next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const acc = accounts[i % accounts.length];
      const user = acc.users[Math.floor(Math.random() * acc.users.length)];
      const t0 = performance.now();
      try {
        const r = await api("POST", "/v1/consume", acc.h, {
          user_id: user, units: 1, request_id: `p-${RUN}-${i}`,
        });
        latencies.push(performance.now() - t0);
        if (r.status !== 200) errors++;
        else if (r.json.accepted) { accepted++; acc.acceptedUnits += 1; }
        else rejected++;
      } catch {
        errors++;
      }
    }
  }

  const start = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - start) / 1000;

  latencies.sort((a, b) => a - b);
  console.log("\n--- Performance ---");
  console.log(`time: ${seconds.toFixed(2)} s`);
  console.log(`throughput: ${(TOTAL / seconds).toFixed(0)} req/s`);
  console.log(
    `latency ms: p50=${pct(latencies, 50).toFixed(1)} p95=${pct(latencies, 95).toFixed(1)} p99=${pct(latencies, 99).toFixed(1)}`
  );
  console.log(`accepted=${accepted} rejected=${rejected} errors=${errors}`);

  // ---- التحقق من الصحة بعد الاختبار ----
  let correct = errors === 0 && accepted === expectedAccepted;
  for (const acc of accounts) {
    const u = await api("GET", "/v1/account/usage", acc.h);
    const consumed = u.json.account.consumed;
    const sumUsers = u.json.users.reduce((s: number, x: any) => s + x.consumed, 0);
    if (consumed !== acc.acceptedUnits || sumUsers !== consumed || consumed > acc.allowance) {
      correct = false;
      console.log(
        `MISMATCH: account consumed=${consumed}, accepted by client=${acc.acceptedUnits}, sum users=${sumUsers}, allowance=${acc.allowance}`
      );
    }
  }
  console.log("\n--- Correctness ---");
  console.log(`accepted ${accepted} (expected ${expectedAccepted})`);
  console.log(`totals match the database: ${correct ? "PASS" : "FAIL"}`);
  process.exit(correct ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});