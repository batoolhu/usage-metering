import { Router } from "express";
import { pool } from "./db";
import { requireApiKey } from "./auth";

export const plansRouter = Router();

const isNonNegInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

// إنشاء خطة مخصصة
plansRouter.post("/v1/plans", requireApiKey, async (req, res) => {
  const { kind, name, monthly_allowance, max_per_request } = req.body ?? {};

  if (kind !== "account" && kind !== "user") {
    return res.status(400).json({ error: "kind must be 'account' or 'user'" });
  }
  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required" });
  }
  if (!isNonNegInt(monthly_allowance)) {
    return res.status(400).json({ error: "monthly_allowance must be a whole number >= 0" });
  }
  if (!isPosInt(max_per_request)) {
    return res.status(400).json({ error: "max_per_request must be a whole number > 0" });
  }

  // ممنوع نفس اسم خطة جاهزة
  const clash = await pool.query(
    "SELECT 1 FROM plans WHERE account_id IS NULL AND kind = $1 AND name = $2",
    [kind, name.trim()]
  );
  if (clash.rowCount) {
    return res.status(409).json({ error: "name is used by a predefined plan" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO plans (account_id, kind, name, monthly_allowance, max_per_request, is_predefined)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id, kind, name, monthly_allowance, max_per_request, is_predefined`,
      [req.account!.id, kind, name.trim(), monthly_allowance, max_per_request]
    );
    res.status(201).json(result.rows[0]);
  } catch (e: any) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "a plan with this name already exists" });
    }
    throw e;
  }
});

// عرض الخطط: الجاهزة + خطط هالحساب فقط
plansRouter.get("/v1/plans", requireApiKey, async (req, res) => {
  const result = await pool.query(
    `SELECT id, kind, name, monthly_allowance, max_per_request, is_predefined
     FROM plans
     WHERE account_id IS NULL OR account_id = $1
     ORDER BY is_predefined DESC, id`,
    [req.account!.id]
  );
  res.json(result.rows);
});

// تعديل خطة مخصصة
plansRouter.patch("/v1/plans/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(404).json({ error: "plan not found" });
  }

  const found = await pool.query(
    `SELECT is_predefined FROM plans
     WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`,
    [id, req.account!.id]
  );
  if (found.rowCount === 0) {
    return res.status(404).json({ error: "plan not found" });
  }
  if (found.rows[0].is_predefined) {
    return res.status(403).json({ error: "predefined plans are read-only" });
  }

  const { monthly_allowance, max_per_request } = req.body ?? {};
  if (monthly_allowance === undefined && max_per_request === undefined) {
    return res.status(400).json({ error: "nothing to update" });
  }
  if (monthly_allowance !== undefined && !isNonNegInt(monthly_allowance)) {
    return res.status(400).json({ error: "monthly_allowance must be a whole number >= 0" });
  }
  if (max_per_request !== undefined && !isPosInt(max_per_request)) {
    return res.status(400).json({ error: "max_per_request must be a whole number > 0" });
  }

  const result = await pool.query(
    `UPDATE plans
     SET monthly_allowance = COALESCE($1, monthly_allowance),
         max_per_request   = COALESCE($2, max_per_request)
     WHERE id = $3 AND account_id = $4
     RETURNING id, kind, name, monthly_allowance, max_per_request, is_predefined`,
    [monthly_allowance ?? null, max_per_request ?? null, id, req.account!.id]
  );
  res.json(result.rows[0]);
});

// تغيير خطة الحساب نفسه
plansRouter.patch("/v1/account", requireApiKey, async (req, res) => {
  const { plan } = req.body ?? {};
  if (typeof plan !== "string") {
    return res.status(400).json({ error: "plan is required" });
  }
  const p = await pool.query(
    `SELECT id FROM plans
     WHERE kind = 'account' AND name = $1
       AND (account_id IS NULL OR account_id = $2)`,
    [plan, req.account!.id]
  );
  if (p.rowCount === 0) {
    return res.status(400).json({ error: `unknown account plan: ${plan}` });
  }
  await pool.query("UPDATE accounts SET plan_id = $1 WHERE id = $2", [
    p.rows[0].id,
    req.account!.id,
  ]);
  res.json({ plan });
});