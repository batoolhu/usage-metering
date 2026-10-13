import { Router } from "express";
import crypto from "crypto";
import { pool } from "./db";

export const accountsRouter = Router();

const ADMIN_KEY = process.env.ADMIN_KEY ?? "change-me-admin-key";

accountsRouter.post("/accounts", async (req, res) => {
  // 1) تأكدي إن اللي بيطلب معه admin key صحيح
  if (req.header("X-Admin-Key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "invalid admin key" });
  }

  // 2) تحققي من البيانات
  const { name, plan } = req.body ?? {};
  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required" });
  }
  const planName = typeof plan === "string" ? plan : "Starter";

  // 3) دوري على الخطة الجاهزة
  const planRow = await pool.query(
    "SELECT id FROM plans WHERE kind = 'account' AND name = $1 AND account_id IS NULL",
    [planName]
  );
  if (planRow.rowCount === 0) {
    return res.status(400).json({ error: `unknown account plan: ${planName}` });
  }

  // 4) ولّدي الـ key واعملي hash
  const apiKey = "mk_" + crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");

  // 5) خزني الحساب (الـ hash فقط)
  const result = await pool.query(
    "INSERT INTO accounts (name, api_key_hash, plan_id) VALUES ($1, $2, $3) RETURNING id",
    [name.trim(), hash, planRow.rows[0].id]
  );

  // 6) رجعي الـ key مرة وحدة
  res.status(201).json({
    id: result.rows[0].id,
    name: name.trim(),
    plan: planName,
    api_key: apiKey,
  });
});