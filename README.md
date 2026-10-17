# Usage Metering and Quota Service

A backend service that other apps call to ask: "can this user do this action now?" It tracks usage in **units** and answers yes or no.

- An **account** is an app or company. It has a shared monthly allowance.
- A **user** belongs to an account. Each user has their own monthly allowance.
- A **plan** is a set of limits. An account has an account plan, and each user has a user plan. Both plans apply to every request.

Stack: TypeScript, Express, PostgreSQL, Docker Compose.

## Run it

```bash
docker compose up --build
```

This starts the database, the service (http://localhost:3000) and the example client. The service creates the tables and the predefined plans by itself. The client prints a demo and exits.

- Run the client again: `docker compose run --rm client`
- Stop and delete all data: `docker compose down -v`

Settings in `docker-compose.yml`: `DATABASE_URL`, `ADMIN_KEY` (default `change-me-admin-key`, for development only).

## Example client

The client acts like an app. It has two users on different plans and sends documents to the service. Its code never changes, only the plans in the service change:

1. alice (Basic) uses 10 units: **accepted**.
2. alice uses 25 units: **rejected by the user** (her limit per request is 20).
3. alice is moved to Premium. The same 25 units are **accepted**.
4. The account allowance runs low, and bob is **rejected by the account** even though he has units left.
5. The account allowance is raised. The same request from bob is **accepted**.

It prints the decision and the remaining units after every step.

## Predefined plans

| Kind | Name | Units per month | Max per request |
|---|---|---|---|
| account | Starter | 10,000 | 100 |
| account | Pro | 100,000 | 1,000 |
| user | Basic | 500 | 20 |
| user | Premium | 5,000 | 200 |

Predefined plans cannot be changed. An account can create its own plans, and many users can share one plan. Each user still has separate usage.

## API keys

- Creating an account needs the admin key in the header `X-Admin-Key`.
- The response gives the account's API key **once**. The database stores only a hash of it, so a lost key cannot be recovered.
- Every other request sends the key in the header `X-API-Key`. The key tells the service which account is calling, so an account can only see its own data.
- Missing or wrong key: `401`. Data of another account looks like it does not exist: `404`.

## API

| Method | Path | What it does |
|---|---|---|
| POST | `/accounts` | Create an account (admin key) |
| GET, PATCH | `/v1/account` | See the account and its plan, change its plan |
| POST | `/v1/users` | Add a user: `{external_id, plan}` |
| GET, PATCH | `/v1/users/:id` | See a user, change the user's plan |
| POST | `/v1/plans` | Create a custom plan: `{kind, name, monthly_allowance, max_per_request}` |
| GET | `/v1/plans` | List predefined plans and your own plans |
| PATCH | `/v1/plans/:id` | Change a custom plan's limits |
| POST | `/v1/consume` | Use units: `{user_id, units, request_id}` |
| GET | `/v1/account/usage?month=2026-10` | Used and remaining units for the account and all users |
| GET | `/v1/users/:id/usage?month=2026-10` | Used and remaining units for one user |
| GET | `/v1/requests?limit=&cursor=` | History of accepted and rejected requests |

Errors: `400` bad input, `401` bad key, `403` changing a predefined plan, `404` not found, `409` conflict. Without `month`, the current month is used.

Example:

```bash
curl -X POST http://localhost:3000/accounts -H "X-Admin-Key: change-me-admin-key" \
  -H "Content-Type: application/json" -d '{"name":"Acme","plan":"Starter"}'
# {"id":"1","name":"Acme","plan":"Starter","api_key":"mk_..."}

curl -X POST http://localhost:3000/v1/users -H "X-API-Key: mk_..." \
  -H "Content-Type: application/json" -d '{"external_id":"alice","plan":"Basic"}'

curl -X POST http://localhost:3000/v1/consume -H "X-API-Key: mk_..." \
  -H "Content-Type: application/json" \
  -d '{"user_id":"alice","units":25,"request_id":"req-1"}'
```

On Windows PowerShell, use `Invoke-RestMethod` instead of `curl`.

A rejected request looks like this (nothing is consumed):

```json
{ "request_id": "req-1", "accepted": false, "rejected_by": "user",
  "rule": "max_per_request", "limit": 20, "replayed": false,
  "user": { "consumed": 0, "remaining": 500 },
  "account": { "consumed": 0, "remaining": 10000 } }
```

`rejected_by` is `user` or `account`. `rule` is `max_per_request` or `monthly_allowance`.

## Rules

Two rules, for both account plans and user plans:

1. **Monthly allowance**: total units per UTC month.
2. **Max per request**: the largest amount in one request.

A request is accepted only if every check passes. They run in this order, and the first one that fails is reported: user max per request, account max per request, user monthly allowance, account monthly allowance.

When a request is accepted, the units are added to the user and to the account. A rejected request adds nothing. Each new month starts at zero, and old months can still be queried.

## Changing plans

- A change applies to the next request. The service reads the plan from the database every time, so no restart is needed.
- Changing a plan keeps the units already used. It does not give a fresh allowance.
- If an allowance is lowered below what was already used, the remaining units show as 0 and requests are rejected until the allowance is raised or the month changes.
- Past request history is never changed.

## Retries

Every request has a `request_id`. The service stores the decision for it.

- Same `request_id` with the same user and units: the stored decision is returned (`"replayed": true`) and nothing is counted again.
- Same `request_id` with a different user or units: `409`.
- To try again after a rejection, send a new `request_id`.

## How it stays correct

`consume` runs inside one database transaction. It locks the usage row of the account, then the usage row of the user. Because of the locks, two requests at the same time cannot spend the same units. The lock order is always the same, to avoid deadlocks. If anything fails, the transaction is rolled back and nothing is consumed. The decision logic is in `service/src/rules.ts` and the transaction is in `service/src/consume.ts`.

Usage is stored in one row per month, so a new month starts at zero without any reset job. History uses a cursor (the last request id) instead of page numbers.

## Assumptions

- Only the admin key can create accounts, because the brief does not say who can.
- A rejected request still returns HTTP 200 with `accepted: false`, because the rejection is the service's decision and the request itself was valid.
- One `request_id` always has the same decision.
- Past months are shown with the current plan limits, because plan history is not stored.
- `units` must be a positive whole number.

## Tests

```bash
docker compose up -d --build
cd service
npm install
npm test
```

27 automated tests check: API key validation, account isolation, the examples from the brief, retries, plan changes, previous months, pagination, and many requests at the same time.

## Performance

Scripts are in `perf/`. Details: [perf/RESULTS.md](perf/RESULTS.md).

```bash
docker compose run --rm -v "${PWD}/perf:/perf" -e SERVICE_URL=http://service:3000 client npx tsx /perf/load.ts many
docker compose run --rm -v "${PWD}/perf:/perf" -e SERVICE_URL=http://service:3000 client npx tsx /perf/load.ts hot
```

`many` sends 5,000 requests across 20 accounts. `hot` sends 5,000 requests to one account with a 3,000 allowance, so exactly 3,000 must be accepted and 2,000 rejected. After each run the script checks the totals in the database.

| Scenario | Before | After | Totals correct |
|---|---|---|---|
| many | 69 req/s | 87 req/s | yes |
| hot | 47 req/s | 53-60 req/s | yes |

What I learned:

- Testing from my laptop was slow because of the environment. Inside Docker, `/health` was 10 times faster.
- A big part of each request is waiting for the database to write to disk. Turning that off made it faster, but I kept it on because a crash could lose decisions.
- The improvement I kept: fewer database calls per request (14 down to 9), with the same logic. All tests still pass.

## Known limitations

- Requests for the same account wait for each other, so one very busy account is limited in speed.
- No plan history, so past months use the current plan.
- The request history table grows forever.
- No key rotation, no deleting accounts or plans, no rate limiting.
- The passwords in `docker-compose.yml` are for local development only.
- Speed numbers come from one or two runs on one laptop, and they vary by about 10%.
