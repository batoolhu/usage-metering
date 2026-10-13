import express from "express";
import { pool } from "./db";
import { migrate } from "./migrate";
import { seed } from "./seed";
import { accountsRouter } from "./accounts";
async function main() {
  await migrate();
   await seed();

  const app = express();
  app.use(express.json());
    app.use(accountsRouter);

  app.get("/health", async (_req, res) => {
    const result = await pool.query("SELECT 1 AS ok");
    res.json({ status: "ok", db: result.rows[0].ok === 1 });
  });

  app.listen(3000, () => {
    console.log("service listening on port 3000");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});