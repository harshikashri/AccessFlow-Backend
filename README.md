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

## Organization management

Organization management endpoints are restricted to authenticated Super Admins. Organization creation provisions the organization, its first Organization Admin user, the default organization-scoped role assignment, and audit records in one MongoDB transaction. MongoDB must run as a replica set (or a transaction-capable sharded cluster) for organization create, update, and activation changes.

Base path: `/api/organizations`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/organizations` | Create an organization and its first admin |
| `GET` | `/api/organizations` | List organizations |
| `GET` | `/api/organizations/:organizationId` | Get organization details and member counts |
| `PATCH` | `/api/organizations/:organizationId` | Update the organization name |
| `PATCH` | `/api/organizations/:organizationId/activate` | Activate an organization |
| `PATCH` | `/api/organizations/:organizationId/deactivate` | Deactivate an organization |

Create request:

```json
{
  "name": "Acme Corp",
  "admin": {
    "name": "Jane Admin",
    "email": "jane.admin@example.com",
    "password": "A-strong-password1!"
  }
}
```

List query parameters: `page`, `limit` (maximum 100), `search`, `status` (`ACTIVE` or `INACTIVE`), `sortBy` (`name`, `createdAt`, `updatedAt`, or `status`), and `sortOrder` (`asc` or `desc`).

Organization names and admin emails must be unique. Deactivated organizations remain visible to Super Admins, but their members cannot establish or refresh organization sessions until reactivation.

---

## Department management

Departments belong to the authenticated organization. The existing `departments` collection stores manager IDs; employee assignments are stored in the matching embedded `users.organizationMemberships` entry. No membership collection is used. A user can have only one department per organization, and removing a user from a department clears only that membership's `departmentId`.

All endpoints require a Bearer access token with an active organization context. Access is derived from active `userRoleAssignments` and active roles in the same organization. Organization-scoped permissions apply across that organization; department-scoped permissions apply only to their assigned department. Super Admin status by itself does not grant department access.

Base path: `/api/departments`

| Method | Path | Purpose | Required permission |
|---|---|---|---|
| `POST` | `/api/departments` | Create a department | Organization-scoped `departments.create` |
| `GET` | `/api/departments` | List departments | `departments.view` |
| `GET` | `/api/departments/:departmentId` | Get department details | `departments.view` |
| `PATCH` | `/api/departments/:departmentId` | Update name or description | `departments.edit` |
| `PATCH` | `/api/departments/:departmentId/managers` | Replace the full manager list | `departments.edit` |
| `POST` | `/api/departments/:departmentId/members` | Add organization members | `departments.edit` |
| `DELETE` | `/api/departments/:departmentId/members/:userId` | Remove a member from the department | `departments.edit` |
| `PATCH` | `/api/departments/:departmentId/activate` | Activate a department | `departments.edit` |
| `PATCH` | `/api/departments/:departmentId/deactivate` | Deactivate a department | `departments.edit` |

Create request:

```json
{
  "name": "Engineering",
  "description": "Software development and engineering department"
}
```

Manager replacement request (an empty array removes all managers):

```json
{
  "managerIds": ["USER_OBJECT_ID_1", "USER_OBJECT_ID_2"]
}
```

Member addition request:

```json
{
  "userIds": ["USER_OBJECT_ID_1", "USER_OBJECT_ID_2"]
}
```

Example create response:

```json
{
  "success": true,
  "message": "Department created successfully.",
  "data": {
    "id": "DEPARTMENT_OBJECT_ID",
    "organizationId": "ORGANIZATION_OBJECT_ID",
    "name": "Engineering",
    "description": "Software development and engineering department",
    "status": "ACTIVE",
    "managerCount": 0,
    "memberCount": 0,
    "createdAt": "2026-11-03T00:00:00.000Z",
    "updatedAt": "2026-11-03T00:00:00.000Z"
  }
}
```

List query parameters are `page`, `limit` (maximum 100), `search` (name), `status` (`ACTIVE` or `INACTIVE`), `sortBy` (`name`, `description`, `status`, `createdAt`, or `updatedAt`), and `sortOrder` (`asc` or `desc`). Responses include `data.items` and `data.pagination`; department items include manager and active-membership counts. Detail responses include safe manager/member profiles and counts, never password hashes.

Managers must be active users with an active organization membership and an existing active role assignment granting the existing `departments.edit` permission either organization-wide or for this department. Assignment does not create or broaden a role. There is no dedicated Department Manager role or permission in the current catalog; provisioning such a role remains a Role Management responsibility. Manager updates replace the complete `managerIds` list and are audited per added/removed manager.

Member additions require active users with an active membership in this organization. Users already assigned to another department receive `409 MEMBER_IN_ANOTHER_DEPARTMENT`; they must be explicitly removed from that department before being added here. Department deactivation retains manager and member references, but prevents new manager/member assignments and department edits. All department writes require an active parent organization. Multi-document writes and their audit records are committed together using MongoDB transactions.

Successful responses use `{ "success": true, "message": "...", "data": ... }`. Errors use `{ "success": false, "message": "...", "code": "..." }`. Common statuses are `400` for invalid input, `401` for missing/invalid authentication, `403` for missing permissions or inactive organization/department, `404` for a department outside the caller's organization or a missing resource, and `409` for duplicate names or conflicting assignments. Audit actions are `DEPARTMENT_CREATED`, `DEPARTMENT_UPDATED`, `DEPARTMENT_MANAGER_ASSIGNED`, `DEPARTMENT_MANAGER_REMOVED`, `DEPARTMENT_MEMBER_ADDED`, `DEPARTMENT_MEMBER_REMOVED`, `DEPARTMENT_ACTIVATED`, and `DEPARTMENT_DEACTIVATED`.

Example error response:

```json
{
  "success": false,
  "message": "A department with this name already exists in the organization.",
  "code": "DEPARTMENT_NAME_EXISTS"
}
```

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
