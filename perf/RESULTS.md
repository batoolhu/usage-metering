# Performance results

## How I tested
- `perf/load.ts`: sends 5000 `POST /v1/consume` requests with 50 in flight at once.
  - `many`: 20 accounts x 10 users (normal traffic).
  - `hot`: one account, 200 users, allowance 3000 (every request competes for the same account row). Expected result: exactly 3000 accepted and 2000 rejected.
- After each run the script checks correctness: accepted count, account usage equals the sum of accepted units, user totals add up to the account total, and the allowance is never exceeded.
- `perf/baseline.ts`: 3000 x `GET /health`, used to measure the cost of the environment itself.
- Measured from inside the Docker network, on a Windows laptop with Docker Desktop.

## Results

| Scenario | Before | After | Correctness |
|---|---|---|---|
| many | 69 req/s (p50 676 ms) | 87 req/s (p50 520 ms) | PASS |
| hot | 47 req/s (p50 950 ms) | 60 req/s (p50 736 ms) | PASS |

## What I learned
1. Running the load script from Windows gave 140 req/s even for `/health`. From inside Docker it was 1635 req/s. The first measurements were limited by the environment, not by the service.
2. Each `consume` takes a database transaction, and a large share of its time is waiting for the commit to reach disk. Turning off `synchronous_commit` (as an experiment only) raised `many` from 69 to 135 req/s. I did not keep this: it can lose recent decisions after a crash, which is not acceptable for accounting.
3. The improvement I kept: fewer round trips per request (about 14 down to 9) by merging queries. Same transaction, same lock order, same rules. All 27 tests still pass.
4. `hot` is slower than `many` because requests for the same account run one after another on the locked account usage row.

## Limitations
- One run per scenario, so differences of around 5-10% are within noise.
- Everything runs on one machine, so the load generator, service and database compete for the same CPU and disk.
- A bigger gain would need a different approach (for example batching writes), which I did not try.

## Reproduce
docker compose up -d --build
docker compose run --rm -v "${PWD}/perf:/perf" -e SERVICE_URL=http://service:3000 client npx tsx /perf/baseline.ts
docker compose run --rm -v "${PWD}/perf:/perf" -e SERVICE_URL=http://service:3000 client npx tsx /perf/load.ts many
docker compose run --rm -v "${PWD}/perf:/perf" -e SERVICE_URL=http://service:3000 client npx tsx /perf/load.ts hot