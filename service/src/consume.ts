import { PoolClient } from "pg";
import { pool } from "./db";
import { Decision, Side, evaluate, remaining } from "./rules";

export class UserNotFoundError extends Error {}
export class RequestConflictError extends Error {}

export interface ConsumeInput {
  accountId: string;
  userExternalId: string;
  units: number;
  requestId: string;
}

// حدود الحساب والمستخدم بـ query واحد.
// بتنقرأ من الـ DB كل طلب، فتعديل الخطة بيأثر فوراً.
async function loadLimits(client: PoolClient, accountId: string, userId: string) {
  const r = await client.query(
    `SELECT ap.monthly_allowance AS a_allow, ap.max_per_request AS a_max,
            up.monthly_allowance AS u_allow, up.max_per_request AS u_max
     FROM accounts a
     JOIN plans ap ON ap.id = a.plan_id
     JOIN users u ON u.id = $2
     JOIN plans up ON up.id = u.plan_id
     WHERE a.id = $1`,
    [accountId, userId]
  );
  const row = r.rows[0];
  return {
    account: { monthlyAllowance: Number(row.a_allow), maxPerRequest: Number(row.a_max) },
    user: { monthlyAllowance: Number(row.u_allow), maxPerRequest: Number(row.u_max) },
  };
}

// قراءة الاستخدام بدون قفل (بنستخدمها للـ retry بس)
async function readUsage(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: string
) {
  const a = await client.query(
    "SELECT consumed FROM account_usage WHERE account_id = $1 AND month = $2",
    [accountId, month]
  );
  const u = await client.query(
    "SELECT consumed FROM user_usage WHERE user_id = $1 AND month = $2",
    [userId, month]
  );
  return {
    account: Number(a.rows[0]?.consumed ?? 0),
    user: Number(u.rows[0]?.consumed ?? 0),
  };
}

export async function consume(input: ConsumeInput) {
  const { accountId, userExternalId, units, requestId } = input;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) المستخدم لازم يكون تابع لهالحساب (العزل) + الشهر الحالي (UTC) بنفس الـ query
    const u = await client.query(
      `SELECT id,
              to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month
       FROM users WHERE account_id = $1 AND external_id = $2`,
      [accountId, userExternalId]
    );
    if (u.rowCount === 0) throw new UserNotFoundError();
    const userId: string = u.rows[0].id;
    const month: string = u.rows[0].month;

    // 2) سجّلي الطلب. إذا request_id مكرر ما بيضيف شي (retry)
    const ins = await client.query(
      `INSERT INTO requests (account_id, user_id, request_id, units, month)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, request_id) DO NOTHING
       RETURNING id`,
      [accountId, userId, requestId, units, month]
    );

    let decision: Decision;
    let sides: { account: Side; user: Side };
    let replayed = false;

    if (ins.rowCount === 0) {
      // ----- Retry: رجّعي نفس القرار القديم بدون ما نحسب شي مرة ثانية -----
      const old = await client.query(
        `SELECT user_id, units, accepted, rejected_by, rejected_rule, rejected_limit,
                to_char(month, 'YYYY-MM-DD') AS month
         FROM requests WHERE account_id = $1 AND request_id = $2`,
        [accountId, requestId]
      );
      const r = old.rows[0];
      if (r.user_id !== userId || Number(r.units) !== units) {
        throw new RequestConflictError();
      }
      replayed = true;
      decision = r.accepted
        ? { accepted: true }
        : {
            accepted: false,
            rejectedBy: r.rejected_by,
            rule: r.rejected_rule,
            limit: Number(r.rejected_limit),
          };
      const limits = await loadLimits(client, accountId, userId);
      const usage = await readUsage(client, accountId, userId, r.month);
      sides = {
        account: { ...limits.account, consumed: usage.account },
        user: { ...limits.user, consumed: usage.user },
      };
    } else {
      // ----- طلب جديد -----
      // إنشاء صف الشهر إذا مش موجود + قفله + قراءة الاستخدام، كلها بـ query واحد لكل جهة.
      // الترتيب ثابت دايماً: الحساب أول ثم المستخدم (لتجنب deadlock).
      const aUse = await client.query(
        `INSERT INTO account_usage (account_id, month, consumed) VALUES ($1, $2, 0)
         ON CONFLICT (account_id, month)
         DO UPDATE SET consumed = account_usage.consumed
         RETURNING consumed`,
        [accountId, month]
      );
      const uUse = await client.query(
        `INSERT INTO user_usage (user_id, month, consumed) VALUES ($1, $2, 0)
         ON CONFLICT (user_id, month)
         DO UPDATE SET consumed = user_usage.consumed
         RETURNING consumed`,
        [userId, month]
      );

      const limits = await loadLimits(client, accountId, userId);
      sides = {
        account: { ...limits.account, consumed: Number(aUse.rows[0].consumed) },
        user: { ...limits.user, consumed: Number(uUse.rows[0].consumed) },
      };

      // القرار
      decision = evaluate(units, sides.user, sides.account);

      if (decision.accepted) {
        // تحديث الجدولين بـ statement واحد
        await client.query(
          `WITH a AS (
             UPDATE account_usage SET consumed = consumed + $1
             WHERE account_id = $2 AND month = $4
           )
           UPDATE user_usage SET consumed = consumed + $1
           WHERE user_id = $3 AND month = $4`,
          [units, accountId, userId, month]
        );
        sides.account.consumed += units;
        sides.user.consumed += units;
      }

      // سجّلي القرار بالتاريخ (مقبول أو مرفوض)
      await client.query(
        `UPDATE requests
         SET accepted = $1, rejected_by = $2, rejected_rule = $3, rejected_limit = $4
         WHERE account_id = $5 AND request_id = $6`,
        [
          decision.accepted,
          decision.accepted ? null : decision.rejectedBy,
          decision.accepted ? null : decision.rule,
          decision.accepted ? null : decision.limit,
          accountId,
          requestId,
        ]
      );
    }

    await client.query("COMMIT");

    return {
      request_id: requestId,
      accepted: decision.accepted,
      ...(decision.accepted
        ? {}
        : { rejected_by: decision.rejectedBy, rule: decision.rule, limit: decision.limit }),
      replayed,
      user: { consumed: sides.user.consumed, remaining: remaining(sides.user) },
      account: { consumed: sides.account.consumed, remaining: remaining(sides.account) },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}