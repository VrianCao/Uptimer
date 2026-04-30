# API-Reference.md: Uptimer (Cloudflare Runtime + D1 + HTTP Calls)

目的：把 Uptimer 可能用到的「平台运行时 API / 数据库 API / 出站 HTTP/TCP 调用 / 内部 HTTP API」集中整理成一份可查阅的参考。

来源说明：

- “提炼”部分来自既有 Cloudflare Workers、D1、TCP sockets 等实践用法（仅提炼 API 用法，不借鉴外部架构/业务实现）。
- “补全”部分基于 Cloudflare 官方文档（见本文末尾 References）。

---

## Contents

- 1. Cloudflare Workers：入口与上下文
- 2. fetch：出站 HTTP 调用（监控 + webhook + 工具请求）
- 3. TCP sockets：`cloudflare:sockets`（TCP 端口探测）
- 4. D1：Workers Binding API（SQLite 语义）
- 5. Durable Objects（可选，用于未来多地域探测）
- 6. Web Crypto：Webhook 签名（HMAC-SHA256，可选）
- 7. Workers Cache API：`caches.default`（可选，用于公共接口加速）
- 8. Uptimer 内部 HTTP API（供前端调用；摘要）
- 9. Hono（Worker 路由框架）
- 10. Drizzle ORM（D1/SQLite driver）

---

## 1) Cloudflare Workers：入口与上下文

### 1.1 Module Worker 入口

```ts
export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  // 其他 bindings / secrets...
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response('ok');
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // controller.cron: string (cron 表达式)
  },
} satisfies ExportedHandler<Env>;
```

相关点：

- `scheduled()` 用于 Cron Triggers（wrangler/Dashboard 配置）。
- `ExecutionContext.waitUntil()` 用于把异步任务延长到 handler 结束之后继续执行（不阻塞响应）。

### 1.2 ctx.waitUntil（后台任务）

典型用途：

- 发送 webhook 通知
- 写缓存（`caches.default.put`）
- 记录异步日志/统计（例如写入 Analytics Engine，若未来启用）

```ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(doSomethingAsync());
    return new Response('ok');
  },
};
```

References：

- Workers Context API（`ctx.waitUntil`）：https://developers.cloudflare.com/workers/runtime-apis/context/

### 1.3 Cron Triggers（wrangler 配置）

```toml
[triggers]
crons = ["* * * * *"] # 每分钟
```

注意：

- Cron 以 UTC 解释，触发可能存在抖动；Uptimer 需要按 `interval_sec` 做“到期探测”，而不是假设每分钟全量扫一遍。

### 1.4 Incoming Request CF 信息（仅 fetch handler 可用）

在 `fetch()` 中可以读取 Cloudflare 注入的请求上下文（如 colo / country / tls 等）。`scheduled()` 没有 inbound request，无法使用该能力。

```ts
export default {
  async fetch(request: Request) {
    // @ts-expect-error: request.cf is Workers-specific.
    const colo = request.cf?.colo;
    // @ts-expect-error: request.cf is Workers-specific.
    const country = request.cf?.country;
    return Response.json({ colo, country });
  },
};
```

### 1.5 并发限制（p-limit，用于批量探测）

基于 Workers 实践：Workers 存在出站连接并发限制，批量探测时建议限制并发数（例如 5）。

```ts
import pLimit from 'p-limit';

const limit = pLimit(5);
const results = await Promise.all(monitors.map((m) => limit(() => runCheck(m))));
```

---

## 2) fetch：出站 HTTP 调用（监控 + webhook + 工具请求）

### 2.1 禁用缓存（监控请求必须做）

Workers 对 `fetch` 支持 `cache: 'no-store' | 'no-cache'`（仅支持这两种）。

推荐（用于监控目标请求）：

```ts
const res = await fetch(url, {
  method: 'GET',
  cache: 'no-store',
  cf: {
    // 对所有状态码禁用缓存
    cacheTtlByStatus: { '100-599': -1 },
  },
});
```

References：

- fetch cache directives（no-store / no-cache）：https://developers.cloudflare.com/workers/examples/cache-using-fetch/
- fetch cf cache 示例（含 cacheTtlByStatus 结构示例）：https://developers.cloudflare.com/workers/examples/cache-using-fetch/

### 2.2 AbortController 超时封装

```ts
export function fetchTimeout(
  url: string,
  ms: number,
  init: RequestInit<RequestInitCfProperties> = {},
): Promise<Response> {
  const controller = new AbortController();

  // 若调用方也传入 signal，转发 abort
  if (init.signal) {
    init.signal.addEventListener('abort', () => controller.abort());
  }

  const t = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}
```

实践建议：

- 监控请求默认 10s；webhook 默认 5s（可配置）。
- 对于需要读取 body 的断言场景，尽量在完成断言后调用 `response.body?.cancel()`，避免长连接占用。

### 2.3 解析 Cloudflare 运行位置（colo）

实践用法：请求 `https://cloudflare.com/cdn-cgi/trace`，解析 `colo=...`。

```ts
export async function getWorkerColo(): Promise<string | null> {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { cache: 'no-store' });
  const text = await res.text();
  return /^colo=(.*)$/m.exec(text)?.[1] ?? null;
}
```

说明：

- `scheduled()` 没有 inbound request，因此无法使用 `request.cf.colo`，用 trace 是一种可行手段。

### 2.4 Webhook 发送（JSON / form / query param）

JSON：

```ts
const headers = new Headers({
  'Content-Type': 'application/json',
  'User-Agent': 'Uptimer/0.1',
});
headers.set('Authorization', 'Bearer <token>'); // 可选

const resp = await fetchTimeout(webhookUrl, 5000, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
});
```

`application/x-www-form-urlencoded`：

```ts
const resp = await fetchTimeout(webhookUrl, 5000, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ a: '1', b: '2' }).toString(),
});
```

Query param（通常用于 GET webhook）：

```ts
const u = new URL(webhookUrl);
u.searchParams.set('msg', 'hello');
const resp = await fetchTimeout(u.toString(), 5000, { method: 'GET' });
```

### 2.5 Response headers（CORS / no-store）

基于 Edge API 实践：公开数据接口通常加 CORS；状态类接口/徽章类接口通常显式禁止缓存。

```ts
const headers = new Headers({
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
});

return new Response(JSON.stringify({ ok: true }), { headers });
```

---

## 3) TCP sockets：`cloudflare:sockets`（TCP 端口探测）

### 3.1 连接与关闭（官方 API）

```ts
import { connect } from 'cloudflare:sockets';

const socket = connect({ hostname: 'example.com', port: 443 });
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode('...'));
await writer.close();
socket.close();
```

References：

- TCP sockets API：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

### 3.1.1 提炼：为兼容某些打包器的动态 import 写法

当你的构建链对 `cloudflare:sockets` 产生打包/解析问题时，可以用动态 import：

```ts
const connect = await import('cloudflare:sockets').then((m) => m.connect);
const socket = connect({ hostname: 'example.com', port: 443 });
```

### 3.2 用作 TCP health-check（握手延迟）

Workers TCP Socket `Socket` 提供（文档描述）：

- 一个“连接建立后 resolve”的 Promise（通常命名为 `socket.opened`）
- 一个“连接关闭后 resolve”的 Promise（通常命名为 `socket.closed`）
- `socket.close()` 强制关闭读写两端

建议实现（仅握手 + 立即关闭）：

```ts
import { connect } from 'cloudflare:sockets';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => t && clearTimeout(t));
}

export async function tcpPing(hostname: string, port: number, timeoutMs: number): Promise<number> {
  const start = Date.now();
  const socket = connect({ hostname, port });
  // @ts-expect-error: Workers runtime Socket has opened/closed promises.
  await withTimeout(socket.opened, timeoutMs);
  socket.close();
  return Date.now() - start;
}
```

注意：

- TCP 探测属于“受控 SSRF/端口探测能力”，必须做目标校验与速率控制（见 `Application.md` 安全章节）。

---

## 4) D1：Workers Binding API（SQLite 语义）

### 4.1 wrangler 绑定（示例）

```toml
[[d1_databases]]
binding = "DB"
database_name = "uptimer"
database_id = "<uuid>"
```

References：

- Wrangler 配置 D1 bindings：https://developers.cloudflare.com/workers/wrangler/configuration/

### 4.2 Prepared Statement：prepare / bind / run / first / raw

```ts
// 1) run(): 返回 D1Result（含 meta + results）
const r1 = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
  .bind(123)
  .run<{ id: number; name: string }>();

// 2) first(): 返回首行对象或 null（无 meta）
const row = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
  .bind(123)
  .first<{ id: number; name: string }>();

// 3) raw(): 返回二维数组（可选 columnNames）
const raw = await env.DB.prepare('SELECT id, name FROM monitors ORDER BY id DESC LIMIT 10').raw({
  columnNames: true,
});
```

要点：

- `run()` 与 `all()` 在 D1 中等价（文档说明 run 可视为 all 的别名）；写操作时 `results` 为空，变化信息在 `meta.changes/last_row_id`。
- 参数化绑定遵循 SQLite：`?`、`?1`、`?2` 等（避免 SQL 注入）。
- 如果你手上是一个参数数组，使用 `.bind(...params)`（不要把数组当成单个参数传入）。

补充：`all()`（等价于 `run()`）

```ts
const r = await env.DB.prepare('SELECT * FROM monitors').all();
```

补充：`first(columnName)`（只取首行某列的值）

```ts
const lastId = await env.DB.prepare('SELECT MAX(id) AS id FROM monitors').first<number>('id');
```

References：

- Prepared statements（bind/run/first/raw）：https://developers.cloudflare.com/d1/worker-api/prepared-statements/

### 4.3 D1Database.batch（多语句批量执行）

```ts
const stmts = [
  env.DB.prepare(
    'INSERT INTO check_results (monitor_id, checked_at, status) VALUES (?, ?, ?)',
  ).bind(monitorId, checkedAt, status),
  env.DB.prepare(
    'UPDATE monitor_state SET status = ?, last_checked_at = ? WHERE monitor_id = ?',
  ).bind(status, checkedAt, monitorId),
];

const results = await env.DB.batch(stmts);
// results: D1Result[]，每条语句一个结果（含 meta）
```

References：

- D1 Database batch/exec 教程示例：https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1

### 4.4 D1Database.exec（执行原始 SQL 字符串）

```ts
await env.DB.exec('PRAGMA foreign_keys = ON;');
```

注意：

- `exec()` 不支持 bind 参数；仅用于受控 SQL（例如维护/调试/固定语句），不要用于拼接用户输入。

References：

- D1 exec 示例：https://developers.cloudflare.com/d1/worker-api/return-object

### 4.5 提炼：“D1 当 KV 用” 写法（示例）

一种早期轻量写法是在 D1 内建一个 `kv_store(key, value)` 表，通过 UPSERT 存/取一个大 JSON 状态 blob：

```ts
// get
const row = await env.DB.prepare('SELECT value FROM kv_store WHERE key = ?')
  .bind('state')
  .first<{ value: string }>();

// set (UPSERT)
await env.DB.prepare(
  'INSERT INTO kv_store (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
)
  .bind('state', stateJson)
  .run();
```

说明：

- Uptimer v0.x 采用“关系表 + retention”，不建议把所有状态压成单 blob；但上述示例对理解 D1 prepare/bind/run 很直观。

### 4.6 D1 分布式锁（lease lock，用于 scheduled 防重叠）

Uptimer v0.x 推荐用 D1 `locks(name, expires_at)` 实现一个简单 lease：

获取锁（仅当不存在或已过期时覆盖）：

```ts
const now = Math.floor(Date.now() / 1000);
const ttl = 55;
const expiresAt = now + ttl;

const sql =
  'INSERT INTO locks (name, expires_at) VALUES (?, ?) ' +
  'ON CONFLICT(name) DO UPDATE SET expires_at = excluded.expires_at ' +
  'WHERE locks.expires_at <= ?;';

const r = await env.DB.prepare(sql).bind('scheduler', expiresAt, now).run();
const acquired = (r.meta?.changes ?? 0) > 0;
```

释放锁（可选；通常让其自然过期即可）：

```ts
await env.DB.prepare('DELETE FROM locks WHERE name = ?').bind('scheduler').run();
```

### 4.7 Public snapshot fast path tables

当前发布基线使用 D1 静态快照 + fragments 支撑 Free Plan CPU profile：

```sql
CREATE TABLE IF NOT EXISTS public_snapshots (
  key TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE TABLE IF NOT EXISTS public_snapshot_guard_versions (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_json TEXT
);

CREATE TABLE IF NOT EXISTS public_snapshot_fragments (
  snapshot_key TEXT NOT NULL,
  fragment_key TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (snapshot_key, fragment_key)
);
CREATE INDEX IF NOT EXISTS idx_public_snapshot_fragments_snapshot_generated
  ON public_snapshot_fragments(snapshot_key, generated_at);
```

Key conventions:

- `public_snapshots.key`: `homepage` / `status` / `homepage:artifact`。
- `public_snapshot_fragments.snapshot_key`: `homepage:envelope`、`homepage:monitors`、`status:envelope`、`status:monitors`、`homepage:artifact:monitors`、`monitor-runtime:updates`。
- artifact rows use `updated_at` for public freshness, while the body/snapshot still validates against stored `generated_at`。

### 4.8 Retention 清理（删除过期 check_results）

```ts
const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
await env.DB.prepare('DELETE FROM check_results WHERE checked_at < ?').bind(cutoff).run();
```

---

## 5) Durable Objects（可选，用于未来多地域探测）

一种可选方案是使用 DO 做“指定 locationHint 的远程探测”，核心 API 点：

```ts
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>;
}

export class RemoteChecker extends DurableObject {
  async getLocationAndStatus(payload: unknown) {
    // ... run check ...
    return { location: 'HKG', status: { up: true, ping: 12, err: '' } };
  }
}
```

调用侧示例：

```ts
const id = env.REMOTE_CHECKER_DO.idFromName(monitorId);
const stub = env.REMOTE_CHECKER_DO.get(id, { locationHint: 'hkg' as DurableObjectLocationHint });
const resp = await stub.getLocationAndStatus(monitorConfig);
```

注意：

- DO 属于 v1+ 扩展点；v0.1 不引入（避免复杂度）。
- 具体需要的 compatibility flags / RPC 形态以 Cloudflare DO 文档为准。

---

## 6) Web Crypto：Webhook 签名（HMAC-SHA256，可选）

用于让 webhook 接收方验证来源、防重放。

```ts
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}
```

用法建议：

- 发送：
  - `X-Uptimer-Timestamp: <unix seconds>`
  - `X-Uptimer-Signature: sha256=<hex>`
  - `signature = HMAC(secret, timestamp + "." + rawBody)`
- 接收方校验 timestamp 在允许窗口内（例如 5 分钟），并校验签名。

---

## 7) Workers Cache API：`caches.default`（可选，用于公共接口加速）

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
    });

    ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
```

注意：

- 监控目标探测请求必须禁缓存（见 2.1），Cache API 仅用于你自己的公共 API/状态页数据缓存。

References：

- cache-using-fetch（含 caches.default.put 示例）：https://developers.cloudflare.com/workers/examples/cache-using-fetch/

---

## 8) Uptimer 内部 HTTP API（供前端调用；摘要）

详细定义以 `Application.md` 为准，这里仅列出“会被调用”的 endpoints：

Public（无需鉴权）：

- `GET /api/v1/public/homepage`
- `GET /api/v1/public/homepage-artifact`
- `GET /api/v1/public/status`
- `GET /api/v1/public/monitors/:id/latency?range=24h`
- `GET /api/v1/public/monitors/:id/uptime?range=24h|7d|30d`
- `GET /api/v1/public/incidents?limit=20`
- `GET /api/v1/public/maintenance-windows?limit=20`

Admin（Bearer Token）：

- `GET /api/v1/admin/monitors`
- `POST /api/v1/admin/monitors`
- `PATCH /api/v1/admin/monitors/:id`
- `DELETE /api/v1/admin/monitors/:id`
- `POST /api/v1/admin/monitors/:id/test`
- `GET /api/v1/admin/notification-channels`
- `POST /api/v1/admin/notification-channels`
- `PATCH /api/v1/admin/notification-channels/:id`
- `DELETE /api/v1/admin/notification-channels/:id`
- `POST /api/v1/admin/notification-channels/:id/test`
- `GET /api/v1/admin/incidents`
- `POST /api/v1/admin/incidents`
- `POST /api/v1/admin/incidents/:id/updates`
- `PATCH /api/v1/admin/incidents/:id/resolve`

Internal（Bearer Token；scheduled/service-binding only）：

- `POST /api/v1/internal/scheduled/check-batch`
- `POST /api/v1/internal/write/runtime-update-fragments`
- `POST /api/v1/internal/refresh/runtime-fragments`
- `POST /api/v1/internal/seed/sharded-public-snapshot`
- `POST /api/v1/internal/assemble/sharded-public-snapshot`
- `POST /api/v1/internal/continue/sharded-public-snapshot`

Free Plan CPU profile vars are documented in `Develop/Worker-CPU-10ms-Release-Readiness.md` and enabled in `apps/worker/wrangler.toml`. Do **not** enable `UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED` for the release profile.

---

## 9) Hono（Worker 路由框架）

基础：

```ts
import { Hono } from 'hono';

type Bindings = { DB: D1Database; ADMIN_TOKEN: string };
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/v1/public/status', (c) => c.json({ ok: true }));

export default app;
```

读取 JSON Body：

```ts
app.post('/api/v1/admin/monitors', async (c) => {
  const body = await c.req.json();
  return c.json({ received: body });
});
```

鉴权中间件（示意）：

```ts
import { createMiddleware } from 'hono/factory';

export const requireAdmin = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (auth !== expected)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  await next();
});
```

开启 CORS（可选，适用于 public API）：

```ts
import { cors } from 'hono/cors';

app.use('/api/v1/public/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] }));
```

---

## 10) Drizzle ORM（D1/SQLite driver）

创建 client（Worker 内）：

```ts
import { drizzle } from 'drizzle-orm/d1';

export function getDb(env: { DB: D1Database }) {
  return drizzle(env.DB);
}
```

查询示例（来自 Drizzle Cloudflare D1 文档页面的用法风格）：

```ts
import { drizzle } from 'drizzle-orm/d1';
import { users } from './schema';

const db = drizzle(env.DB);
const rows = await db.select().from(users).all();
```

写入示例（insert / update / delete，通用 Drizzle 用法）：

```ts
import { eq } from 'drizzle-orm';
import { users } from './schema';

await db.insert(users).values({ name: 'Andrew' });
await db.update(users).set({ name: 'Mr. Dan' }).where(eq(users.name, 'Dan'));
await db.delete(users).where(eq(users.name, 'Mr. Dan'));
```

执行原生 SQL（Drizzle `sql`，通用 Drizzle 用法）：

```ts
import { sql } from 'drizzle-orm';

const id = 69;
const r = await db.execute(sql`select * from ${users} where ${users.id} = ${id}`);
```

说明：

- Uptimer 以 “SQL migrations via Wrangler” 为准；Drizzle schema 用于类型安全与查询封装，二者需保持一致。

## References

Cloudflare Workers：

- Cron Triggers / scheduled：https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Context API / waitUntil：https://developers.cloudflare.com/workers/runtime-apis/context/
- Request.cf（IncomingRequestCfProperties）：https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties
- fetch & cache 示例：https://developers.cloudflare.com/workers/examples/cache-using-fetch/
- TCP sockets：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- Wrangler config：https://developers.cloudflare.com/workers/wrangler/configuration/

Cloudflare D1：

- Prepared statements：https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- Query D1 best practices：https://developers.cloudflare.com/d1/best-practices/query-d1/
- D1 API tutorial（batch/exec 示例）：https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1
- D1 return object / exec 示例：https://developers.cloudflare.com/d1/worker-api/return-object

Hono：

- Hono docs：https://hono.dev/

Drizzle ORM：

- Cloudflare D1 connection：https://orm.drizzle.team/docs/connect-cloudflare-d1
- SQL template (`sql`)：https://orm.drizzle.team/docs/sql
- Insert / Update / Delete：
  - https://orm.drizzle.team/docs/insert
  - https://orm.drizzle.team/docs/update
  - https://orm.drizzle.team/docs/delete
