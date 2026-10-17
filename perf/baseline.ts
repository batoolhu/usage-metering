const BASE = process.env.SERVICE_URL ?? "http://localhost:3000";
const TOTAL = 3000;
const CONCURRENCY = 50;
let next = 0;

async function worker() {
  while (next++ < TOTAL) {
    const r = await fetch(BASE + "/health");
    await r.text();
  }
}

async function main() {
  const start = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const s = (performance.now() - start) / 1000;
  console.log(`${TOTAL} x GET /health: ${s.toFixed(2)} s -> ${(TOTAL / s).toFixed(0)} req/s`);
}

main();