# AccessFlow Backend

Enterprise Access & Workflow Management Platform — backend API.

## Stack

- Node.js (ES Modules)
- Express.js
- MongoDB + Mongoose

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env with secrets and Super Admin values
npm run seed:super-admin
npm run dev
```

Health check: `GET http://localhost:5000/health`

---

## Authentication architecture

AccessFlow uses a single login system for all actors (Super Admin, Organization Admin, Department Manager, Employee, Auditor). Authorization differences come from `platformRole`, organization memberships, and (later) RBAC — not from separate login endpoints.

### Access token (JWT)

- Short-lived JWT (`ACCESS_TOKEN_EXPIRY`, default `15m`)
- Returned in JSON from `/api/auth/login` and `/api/auth/refresh`
- Frontend should keep it **in memory only** (not `localStorage` / `sessionStorage`)
- Sent as `Authorization: Bearer <accessToken>`
- Claims: `userId`, `sessionId`, `organizationId`, `platformRole`

### Refresh token (opaque)

- Cryptographically random opaque token (not a JWT)
- Sent only as an **HttpOnly** cookie (`refreshToken`)
- Only the SHA-256 hash is stored in `sessions.refreshTokenHash`
- Rotated on every successful refresh
- Default lifetime: `REFRESH_TOKEN_EXPIRY` (e.g. `7d`)

### Refresh token rotation

1. Read refresh cookie
2. Hash and look up the active session
3. Validate session expiry/revocation and user activity
4. Atomically replace `refreshTokenHash` (conditional update)
5. Issue new access + refresh tokens
6. Set the new cookie

**Concurrent refresh:** only one request wins the atomic update. The losing request receives `401` without revoking the winner’s session (avoids killing a legitimate session during parallel tab refreshes).

**Unknown / already-rotated token:** rejected; cookie cleared. We do not revoke all user sessions solely because a single unknown token was presented (reduces accidental lockout from races).

### Cookie configuration

| Option | Env | Default |
|---|---|---|
| HttpOnly | — | `true` |
| Secure | `COOKIE_SECURE` | `false` in development, recommended `true` in production |
| SameSite | `COOKIE_SAME_SITE` | `lax` |
| Path | `COOKIE_PATH` | `/api/auth` |
| Domain | `COOKIE_DOMAIN` | unset (host-only) |

### CSRF considerations

- Access-token APIs use the `Authorization` header (not cookies).
- Cookie-authenticated routes (`login`, `refresh`, `logout`, `logout-all`) validate `Origin`/`Referer` against `CLIENT_URL` when those headers are present.
- SameSite=`lax` further reduces cross-site cookie POSTs.
- Browser clients should send requests from `CLIENT_URL` with credentials included.

---

## Environment variables

See `.env.example`. Important keys:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_ACCESS_SECRET` | Access JWT signing secret |
| `JWT_REFRESH_SECRET` | Reserved/compat secret (refresh tokens are opaque, not JWTs) |
| `ACCESS_TOKEN_EXPIRY` | e.g. `15m` |
| `REFRESH_TOKEN_EXPIRY` | e.g. `7d` |
| `CLIENT_URL` | Frontend origin for CORS + origin checks |
| `COOKIE_*` | Refresh cookie settings |
| `SUPER_ADMIN_*` | Seed script inputs only |

Do not commit real secrets.

---

## Super Admin seeding

There is **no** public registration endpoint for Super Admin.

```bash
# In .env:
# SUPER_ADMIN_NAME=...
# SUPER_ADMIN_EMAIL=...
# SUPER_ADMIN_PASSWORD=...

npm run seed:super-admin
```

Behavior:

- Creates an `ACTIVE` user with `platformRole: "SUPER_ADMIN"` and empty `organizationMemberships`
- Idempotent: re-running for the same Super Admin email makes no changes
- Refuses to convert an existing non–Super Admin account
- Never prints passwords or hashes

---

## Auth endpoints

Base path: `/api/auth`

### `POST /api/auth/login`

```json
{
  "email": "admin@example.com",
  "password": "your-password",
  "organizationId": "optional-for-multi-org-users"
}
```

Success:

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "...",
    "user": {
      "id": "...",
      "name": "...",
      "email": "...",
      "platformRole": "SUPER_ADMIN",
      "organizationId": null
    }
  }
}
```

Sets HttpOnly `refreshToken` cookie. Super Admin sessions use `organizationId: null`.

### `POST /api/auth/refresh`

- Reads refresh cookie
- Rotates refresh token
- Returns new `accessToken`

### `POST /api/auth/logout`

- Revokes current session when a valid access token is present
- Always clears the refresh cookie (idempotent)

### `POST /api/auth/logout-all`

- Requires authentication
- Revokes all sessions for the user
- Clears refresh cookie

### `GET /api/auth/me`

- Requires `Authorization: Bearer <accessToken>`
- Returns safe user profile + active organization context

---

## Postman testing

1. Seed Super Admin and start the server.
2. `POST {{baseUrl}}/api/auth/login` with email/password.
3. Copy `data.accessToken`.
4. For protected calls, set header `Authorization: Bearer <token>`.
5. Enable cookies in Postman so `refreshToken` is stored.
6. `POST {{baseUrl}}/api/auth/refresh` (no body) — confirm new access token + rotated cookie.
7. `GET {{baseUrl}}/api/auth/me` with the Bearer token.
8. `POST {{baseUrl}}/api/auth/logout` then confirm refresh fails.

---

## Frontend token handling (future React app)

1. Store access token **in memory** (e.g. React state / module variable).
2. Attach `Authorization: Bearer <accessToken>` on API calls.
3. Call refresh with `credentials: "include"` (Axios: `withCredentials: true`).
4. On full page reload, call `/api/auth/refresh` to obtain a new access token.
5. Never store access or refresh tokens in `localStorage` or `sessionStorage`.
6. Ensure the SPA origin matches `CLIENT_URL`.

---

## Scripts

```bash
npm install
npm run seed:super-admin
npm run dev
npm start
npm test
```

Tests use the isolated database `accessflow_test` (not `accessflow`).

---

## MongoDB collections

Exactly 10 application collections. Auth uses existing `users` and `sessions` only — no extra collections.
