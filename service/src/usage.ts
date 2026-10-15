import { Router } from "express";
import { pool } from "./db";
import { requireApiKey } from "./auth";
import { remaining } from "./rules";

export const usageRouter = Router();

// بيرجّع أول يوم بالشهر (YYYY-MM-DD)، أو null إذا الصيغة غلط
async function monthStart(raw: unknown): Promise<string | null> {
  if (raw === undefined) {
    const r = await pool.query(
      "SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS m"
    );
    return r.rows[0].m;
  }
  if (typeof raw === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    return `${raw}-01`;
  }
  return null;
}

function shape(row: any) {
  const allowance = Number(row.monthly_allowance);
  const consumed = Number(row.consumed);
  return {
    plan: {
      name: row.plan,
      monthly_allowance: allowance,
      max_per_request: Number(row.max_per_request),
    },
    consumed,
    remaining: remaining({ monthlyAllowance: allowance, maxPerRequest: 0, consumed }),
  };
}

// استخدام الحساب + كل مستخدميه
usageRouter.get("/v1/account/usage", requireApiKey, async (req, res) => {
  const month = await monthStart(req.query.month);
  if (!month) {
    return res.status(400).json({ error: "month must look like 2026-10" });
  }

  const acc = await pool.query(
    `SELECT p.name AS plan, p.monthly_allowance, p.max_per_request,
            COALESCE(au.consumed, 0) AS consumed
     FROM accounts a
     JOIN plans p ON p.id = a.plan_id
     LEFT JOIN account_usage au ON au.account_id = a.id AND au.month = $2::date
     WHERE a.id = $1`,
    [req.account!.id, month]
  );

  const users = await pool.query(
    `SELECT u.external_id, p.name AS plan, p.monthly_allowance, p.max_per_request,
            COALESCE(uu.consumed, 0) AS consumed
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $2::date
     WHERE u.account_id = $1
     ORDER BY u.external_id`,
    [req.account!.id, month]
  );

  res.json({
    month: month.slice(0, 7),
    account: shape(acc.rows[0]),
    users: users.rows.map((r) => ({ user_id: r.external_id, ...shape(r) })),
  });
});

// استخدام مستخدم واحد
usageRouter.get("/v1/users/:externalId/usage", requireApiKey, async (req, res) => {
  const month = await monthStart(req.query.month);
  if (!month) {
    return res.status(400).json({ error: "month must look like 2026-10" });
  }

  const result = await pool.query(
    `SELECT u.external_id, p.name AS plan, p.monthly_allowance, p.max_per_request,
            COALESCE(uu.consumed, 0) AS consumed
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $3::date
     WHERE u.account_id = $1 AND u.external_id = $2`,
    [req.account!.id, String(req.params.externalId), month]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "user not found" });
  }

  res.json({
    month: month.slice(0, 7),
    user_id: result.rows[0].external_id,
    ...shape(result.rows[0]),
  });
});