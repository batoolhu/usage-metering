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

// بيقرأ الاستخدام والحدود الحالية. إذا lock = true بيقفل صفوف الاستخدام
async function loadSides(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: string,
  lock: boolean
) {
  const suffix = lock ? " FOR UPDATE" : "";

  // الترتيب ثابت دايماً: الحساب أول ثم المستخدم (لتجنب deadlock)
  const accUsage = await client.query(
    `SELECT consumed FROM account_usage WHERE account_id = $1 AND month = $2${suffix}`,
    [accountId, month]
  );
  const userUsage = await client.query(
    `SELECT consumed FROM user_usage WHERE user_id = $1 AND month = $2${suffix}`,
    [userId, month]
  );

  // الحدود بتتقرأ من الـ DB كل مرة، فتعديل الخطة بيأثر فوراً
  const accPlan = await client.query(
    `SELECT p.monthly_allowance, p.max_per_request
     FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1`,
    [accountId]
  );
  const userPlan = await client.query(
    `SELECT p.monthly_allowance, p.max_per_request
     FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.id = $1`,
    [userId]
  );

  const side = (usage: any, plan: any): Side => ({
    monthlyAllowance: Number(plan.rows[0].monthly_allowance),
    maxPerRequest: Number(plan.rows[0].max_per_request),
    consumed: Number(usage.rows[0]?.consumed ?? 0),
  });

  return { account: side(accUsage, accPlan), user: side(userUsage, userPlan) };
}

export async function consume(input: ConsumeInput) {
  const { accountId, userExternalId, units, requestId } = input;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) المستخدم لازم يكون تابع لهالحساب (العزل)
    const u = await client.query(
      "SELECT id FROM users WHERE account_id = $1 AND external_id = $2",
      [accountId, userExternalId]
    );
    if (u.rowCount === 0) throw new UserNotFoundError();
    const userId: string = u.rows[0].id;

    // 2) الشهر الحالي (UTC) من الـ DB
    const m = await client.query(
      "SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month"
    );
    const month: string = m.rows[0].month;

    // 3) سجّلي الطلب. إذا request_id مكرر ما بيضيف شي (retry)
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
      sides = await loadSides(client, accountId, userId, r.month, false);
    } else {
      // ----- طلب جديد -----
      await client.query(
        "INSERT INTO account_usage (account_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [accountId, month]
      );
      await client.query(
        "INSERT INTO user_usage (user_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, month]
      );

      // قفل الصفوف وقراءة الحالة
      sides = await loadSides(client, accountId, userId, month, true);

      // القرار
      decision = evaluate(units, sides.user, sides.account);

      if (decision.accepted) {
        await client.query(
          "UPDATE account_usage SET consumed = consumed + $1 WHERE account_id = $2 AND month = $3",
          [units, accountId, month]
        );
        await client.query(
          "UPDATE user_usage SET consumed = consumed + $1 WHERE user_id = $2 AND month = $3",
          [units, userId, month]
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