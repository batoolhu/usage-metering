import { Router } from "express";
import { pool } from "./db";
import { requireApiKey } from "./auth";

export const usersRouter = Router();

// بيدور على خطة user: إما جاهزة أو ملك نفس الحساب
async function findUserPlan(accountId: string, name: string) {
  const r = await pool.query(
    `SELECT id FROM plans
     WHERE kind = 'user' AND name = $1
       AND (account_id IS NULL OR account_id = $2)`,
    [name, accountId]
  );
  return r.rows[0]?.id as string | undefined;
}

// تسجيل مستخدم
usersRouter.post("/v1/users", requireApiKey, async (req, res) => {
  const { external_id, plan } = req.body ?? {};
  if (typeof external_id !== "string" || external_id.trim() === "") {
    return res.status(400).json({ error: "external_id is required" });
  }
  const planName = typeof plan === "string" ? plan : "Basic";
  const planId = await findUserPlan(req.account!.id, planName);
  if (!planId) {
    return res.status(400).json({ error: `unknown user plan: ${planName}` });
  }

  try {
    await pool.query(
      "INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3)",
      [req.account!.id, external_id.trim(), planId]
    );
  } catch (e: any) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "user already exists" });
    }
    throw e;
  }
  res.status(201).json({ external_id: external_id.trim(), plan: planName });
});

// تغيير خطة مستخدم
usersRouter.patch("/v1/users/:externalId", requireApiKey, async (req, res) => {
  const { plan } = req.body ?? {};
  if (typeof plan !== "string") {
    return res.status(400).json({ error: "plan is required" });
  }
  const planId = await findUserPlan(req.account!.id, plan);
  if (!planId) {
    return res.status(400).json({ error: `unknown user plan: ${plan}` });
  }

  const result = await pool.query(
    `UPDATE users SET plan_id = $1
     WHERE account_id = $2 AND external_id = $3`,
    [planId, req.account!.id, req.params.externalId]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "user not found" });
  }
  res.json({ external_id: req.params.externalId, plan });
});

// عرض مستخدم وخطته
usersRouter.get("/v1/users/:externalId", requireApiKey, async (req, res) => {
  const result = await pool.query(
    `SELECT u.external_id, p.name AS plan, p.monthly_allowance, p.max_per_request
     FROM users u JOIN plans p ON p.id = u.plan_id
     WHERE u.account_id = $1 AND u.external_id = $2`,
    [req.account!.id, req.params.externalId]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "user not found" });
  }
  res.json(result.rows[0]);
});
