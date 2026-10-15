export const BASE = process.env.SERVICE_URL ?? "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "change-me-admin-key";

type Hdrs = Record<string, string>;

export async function api(
  method: string,
  path: string,
  headers: Hdrs = {},
  body?: unknown
) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

// حساب جديد بخطة Starter، بيرجّع الـ header الجاهز
export async function newAccount(): Promise<Hdrs> {
  const name = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await api("POST", "/accounts", { "X-Admin-Key": ADMIN_KEY }, { name });
  return { "X-API-Key": r.json.api_key };
}

// حساب بحدود محددة + مستخدمين بحدود محددة
export async function setup(
  account: { allowance: number; max: number },
  users: Record<string, { allowance: number; max: number }>
): Promise<Hdrs> {
  const h = await newAccount();
  await api("POST", "/v1/plans", h, {
    kind: "account", name: "A",
    monthly_allowance: account.allowance, max_per_request: account.max,
  });
  await api("PATCH", "/v1/account", h, { plan: "A" });
  for (const [id, lim] of Object.entries(users)) {
    await api("POST", "/v1/plans", h, {
      kind: "user", name: `P-${id}`,
      monthly_allowance: lim.allowance, max_per_request: lim.max,
    });
    await api("POST", "/v1/users", h, { external_id: id, plan: `P-${id}` });
  }
  return h;
}