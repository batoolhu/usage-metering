import { pool } from "./db";

const PREDEFINED_PLANS = [
  { kind: "account", name: "Starter", allowance: 10000, perRequest: 100 },
  { kind: "account", name: "Pro", allowance: 100000, perRequest: 1000 },
  { kind: "user", name: "Basic", allowance: 500, perRequest: 20 },
  { kind: "user", name: "Premium", allowance: 5000, perRequest: 200 },
];

export async function seed() {
  for (const p of PREDEFINED_PLANS) {
    await pool.query(
      `INSERT INTO plans (account_id, kind, name, monthly_allowance, max_per_request, is_predefined)
       VALUES (NULL, $1, $2, $3, $4, true)
       ON CONFLICT (kind, name) WHERE account_id IS NULL DO NOTHING`,
      [p.kind, p.name, p.allowance, p.perRequest]
    );
  }
  console.log("predefined plans ready");
}