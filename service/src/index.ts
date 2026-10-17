import express, { Request, Response, NextFunction } from "express";
import { pool } from "./db";
import { migrate } from "./migrate";
import { seed } from "./seed";
import { accountsRouter } from "./accounts";
import { usersRouter } from "./users";
import { plansRouter } from "./plans";
import { requireApiKey } from "./auth";
import { consumeRouter } from "./consumeRoute";
import { usageRouter } from "./usage";
import { historyRouter } from "./history";

async function main() {
  await migrate();
  await seed();

  const app = express();
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const result = await pool.query("SELECT 1 AS ok");
    res.json({ status: "ok", db: result.rows[0].ok === 1 });
  });

  app.use(accountsRouter);
  app.use(usersRouter);
  app.use(plansRouter);
  app.use(consumeRouter);
  app.use(usageRouter);
  app.use(historyRouter);
  
  app.get("/v1/account", requireApiKey, async (req, res) => {
    const result = await pool.query(
      `SELECT a.id, a.name, p.name AS plan, p.monthly_allowance, p.max_per_request
       FROM accounts a
       JOIN plans p ON p.id = a.plan_id
       WHERE a.id = $1`,
      [req.account!.id]
    );
    res.json(result.rows[0]);
  });

    app.use((_req, res) => {
    res.status(404).json({ error: "route not found" });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid JSON body" });
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });
  app.listen(3000, () => {
    console.log("service listening on port 3000");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});