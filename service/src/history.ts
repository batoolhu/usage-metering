import { Router } from "express";
import { pool } from "./db";
import { requireApiKey } from "./auth";

export const historyRouter = Router();

historyRouter.get("/v1/requests", requireApiKey, async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: "limit must be a whole number between 1 and 100" });
  }

  let cursor: string | null = null;
  if (req.query.cursor !== undefined) {
    if (typeof req.query.cursor !== "string" || !/^\d+$/.test(req.query.cursor)) {
      return res.status(400).json({ error: "invalid cursor" });
    }
    cursor = req.query.cursor;
  }

  let month: string | null = null;
  if (req.query.month !== undefined) {
    if (
      typeof req.query.month !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
    ) {
      return res.status(400).json({ error: "month must look like 2026-10" });
    }
    month = `${req.query.month}-01`;
  }

  const userId = typeof req.query.user_id === "string" ? req.query.user_id : null;

  // بنجيب limit + 1 لنعرف إذا في صفحة بعدها
  const result = await pool.query(
    `SELECT r.id, r.request_id, u.external_id AS user_id, r.units, r.accepted,
            r.rejected_by, r.rejected_rule, r.rejected_limit,
            to_char(r.month, 'YYYY-MM') AS month, r.created_at
     FROM requests r
     JOIN users u ON u.id = r.user_id
     WHERE r.account_id = $1
       AND ($2::bigint IS NULL OR r.id < $2::bigint)
       AND ($3::text IS NULL OR u.external_id = $3::text)
       AND ($4::date IS NULL OR r.month = $4::date)
     ORDER BY r.id DESC
     LIMIT $5`,
    [req.account!.id, cursor, userId, month, limit + 1]
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);

  res.json({
    items: rows.map((r) => ({
      request_id: r.request_id,
      user_id: r.user_id,
      units: Number(r.units),
      accepted: r.accepted,
      ...(r.accepted
        ? {}
        : {
            rejected_by: r.rejected_by,
            rule: r.rejected_rule,
            limit: Number(r.rejected_limit),
          }),
      month: r.month,
      created_at: r.created_at,
    })),
    next_cursor: hasMore ? String(rows[rows.length - 1].id) : null,
  });
});