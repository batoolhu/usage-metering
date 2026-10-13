import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { pool } from "./db";

declare global {
  namespace Express {
    interface Request {
      account?: { id: string; name: string; planId: string };
    }
  }
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const key = req.header("X-API-Key");
  if (!key) {
    return res.status(401).json({ error: "missing API key" });
  }

  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const result = await pool.query(
    "SELECT id, name, plan_id FROM accounts WHERE api_key_hash = $1",
    [hash]
  );
  if (result.rowCount === 0) {
    return res.status(401).json({ error: "invalid API key" });
  }

  const row = result.rows[0];
  req.account = { id: row.id, name: row.name, planId: row.plan_id };
  next();
}