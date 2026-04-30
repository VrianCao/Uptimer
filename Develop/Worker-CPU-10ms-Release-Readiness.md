# Worker CPU <10ms Release Readiness Notes

> 记录日期：2026-04-29
> 更新日期：2026-04-30
> 适用范围：Uptimer Worker 在 Cloudflare Free Plan `10ms CPU` 限制下的已发布方案
> Main release：PR #77 + PR #78
> Release HEAD：`96f40b2 Merge pull request #78 from VrianCao/release/worker-cpu-10ms-flags`
> Dev/Main：已同步至 `96f40b2`
> Production Tail：已通过

---

## 1. 结论摘要

本轮 controlled Dev 长 Tail 与 production post-release Tail 均已通过严格标准：

```txt
BAD_OR_GE10 count=0
```

最终长 Tail 文件：

```txt
tmp/perf-10ms/dev-tail-deep-split-iter5-final-long-20260429140817.jsonl
```

采样规模：

```txt
1200s tail after warmup
722 Worker events parsed
```

所有采样 invocation path 的 CPU 都严格 `<10ms`，没有出现 `10ms` 或更高样本。

最终 public route parity 也通过：

```txt
/api/v1/public/homepage          200, 26 monitors
/api/v1/public/status            200, 26 monitors
/api/v1/public/homepage-artifact 200, 26 monitors, preload_html present
```

homepage/status 仍保持静态 / 预计算路径，没有把 live compute 作为主方案。

Production post-release parity：

```txt
/api/v1/public/homepage          200, 6 monitors
/api/v1/public/status            200, 6 monitors
/api/v1/public/homepage-artifact 200, 6 monitors, preload_html present
```

---

## 2. 最终长 Tail 数据

Tail 文件：

```txt
tmp/perf-10ms/dev-tail-deep-split-iter5-final-long-20260429140817.jsonl
```

总体：

```txt
objects=722
BAD_OR_GE10 count=0
```

路径统计：

| Invocation path                                          |   n | p95 | p99 | max | ge10 | over10 |
| -------------------------------------------------------- | --: | --: | --: | --: | ---: | -----: |
| cron wrapper `* * * * *`                                 |  20 | 8ms | 8ms | 9ms |    0 |      0 |
| `POST /api/v1/internal/scheduled/check-batch`            | 260 | 4ms | 4ms | 4ms |    0 |      0 |
| `POST /api/v1/internal/continue/sharded-public-snapshot` | 422 | 4ms | 5ms | 6ms |    0 |      0 |
| `POST /api/v1/internal/write/runtime-update-fragments`   |  20 | 1ms | 1ms | 1ms |    0 |      0 |

未出现以下异常 / 回退信号：

```txt
refresh/homepage: 0
Subrequest depth: 0
canceled: 0
HTTP 500: 0
failed: 0
error_name: 0
timed out: 0
falling back inline: 0
internal sharded homepage runtime seed failed: 0
```

### 2.1 Production post-release Tail

Tail 文件：

```txt
tmp/perf-10ms/prod-tail-release-issue24-20260429154407.jsonl
```

总体：

```txt
objects=110
BAD_OR_GE10 count=0
```

| Invocation path                                          |   n | p95 | p99 | max | ge10 |
| -------------------------------------------------------- | --: | --: | --: | --: | ---: |
| cron wrapper `* * * * *`                                 |   7 | 6ms | 6ms | 6ms |    0 |
| `POST /api/v1/internal/scheduled/check-batch`            |  21 | 3ms | 3ms | 5ms |    0 |
| `POST /api/v1/internal/continue/sharded-public-snapshot` |  75 | 2ms | 3ms | 4ms |    0 |
| `POST /api/v1/internal/write/runtime-update-fragments`   |   7 | 1ms | 1ms | 1ms |    0 |

---

## 3. 最终发布 Flags

> 这组 flags 已在 `apps/worker/wrangler.toml` 中作为 Free Plan CPU 发布基线启用。后续如调整任一项，必须重新 Tail 验证。

### 3.1 基础调度参数

```toml
UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = "2"
```

经验：

- `2` 是目前 Dev 实测最稳的基础 batch size。
- batch size `1` 曾增加 wrapper overhead。
- batch size `3/4` 曾把 CPU 压回 check-batch children。

### 3.2 Released Free Plan CPU profile flags

```toml
UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES = "1"
UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH = "1"

UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED = "1"
UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED = "1"
UPTIMER_PUBLIC_SHARDED_ASSEMBLER = "1"
UPTIMER_SCHEDULED_SHARDED_ASSEMBLER = "1"
UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH = "1"
UPTIMER_SCHEDULED_SHARDED_PUBLISH = "1"

UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES = "1"
UPTIMER_SHARDED_ASSEMBLER_MODE = "json"
UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH = "1"
UPTIMER_SCHEDULED_SHARDED_CONTINUATION = "1"

UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE = "4"
UPTIMER_SHARDED_RUNTIME_UPDATE_BATCH_SIZE = "5"

UPTIMER_INTERNAL_SCHEDULED_CHECK_BATCH_TIMEOUT_MS = "75000"
UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT = "1"
UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE = "1"

UPTIMER_SCHEDULED_REFRESH_LOGS = "0"
```

### 3.3 Explicitly disabled / not part of release profile

```toml
# Rejected due CPU outliers.
UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED = "0"

# Diagnostics remain off in release measurements.
UPTIMER_SHARDED_CONTINUATION_DIAGNOSTICS = "0"
UPTIMER_INTERNAL_CHECK_BATCH_DIAGNOSTICS = "0"

# Not used in release profile.
UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY = "0"
```

---

## 4. 关键经验

### 4.1 成功方向：静态 / 预计算 + D1 fragments + continuation

最终方案保留 homepage/status 静态 / 预计算模型：

- public homepage/status 不走 live-compute 主路径。
- `public_snapshots` 存最终可读快照。
- `public_snapshot_fragments` 存 envelope / monitor fragments / artifact monitor fragments。
- cron 只负责小步调度。
- 大任务拆成多次 internal continuation。

这个方向有效降低单次 invocation CPU 峰值。

### 4.2 Raw JSON assembler 是必要优化

Validated assembler 曾测到约 `15-16ms`，不适合作为最终 scheduled path。

最终使用：

```toml
UPTIMER_SHARDED_ASSEMBLER_MODE = "json"
```

经验：

- monitor fragments 在写入前已经按 schema/serializer 生成。
- raw JSON assembly 避免全量对象 parse/validate/stringify 的 CPU 峰值。
- 之前 short samples 中 raw mode max 约 `4ms`。

### 4.3 Trusted scheduler lease 是 check-batch 长尾的核心修复

关键 flag：

```toml
UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE = "1"
```

效果：

- 之前失败长 Tail：check-batch max `31ms`。
- 最终长 Tail：check-batch max `4ms`。

原因：

- controlled scheduled batches 已由 top-level scheduler lease + deterministic unique chunking 保证正常情况下不重叠。
- child check-batch 再获取 batch lock / monitor locks 会增加多次 D1 操作和 CPU/D1 jitter。
- trusted scheduler lease mode 在 gated 条件下跳过这些额外锁。

风险：

- 该模式依赖 scheduler-level lease 和 unique chunking。
- 不应默认开启。
- release rollout 时需要明确只在 scheduled service batch path 使用，并保留 fallback/default-off。

### 4.4 Runtime update fragment writes 需要 split + bulk

最终发布 profile 包含：

```toml
UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT = "1"
UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES = "1"
UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH = "1"
UPTIMER_SHARDED_RUNTIME_UPDATE_BATCH_SIZE = "5"
```

经验：

- 每个 check-batch child 直接写 runtime update fragments 会增加 wrapper/child overhead。
- 改为 scheduler 收集 compact runtime updates 后 bulk 调一次 writer 更稳。
- runtime refresh continuation 分页，避免单次处理过多 update fragments。

最终长 Tail：

```txt
POST /api/v1/internal/write/runtime-update-fragments:
  n=20
  max=1ms
```

### 4.5 homepage artifact 需要预渲染 monitor fragments

最终发布 profile 包含：

```toml
UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES = "1"
```

经验：

- `homepage:artifact` 不能在单次 invocation 里渲染全部 monitor card HTML。
- 每个 monitor 的 preload card HTML 应在 fragment seed 阶段预生成。
- artifact publish 只拼接已预渲染 fragments。
- fragments 缺失 / stale / invalid 时必须拒绝发布坏 artifact。

相关保护：

- missing/stale/invalid artifact monitor fragments 返回 `missing_artifact_fragments` skip。
- 不发布不完整 artifact。

### 4.6 `homepage:artifact` freshness 需要用 `updated_at` 保活

Iteration 4 发现 public parity blocker：

```txt
/api/v1/public/homepage-artifact -> 503
```

原因：

- sharded artifact continuation 判断 artifact row generation 已 current。
- 但 public artifact reader 按 body `generated_at` 判定 freshness。
- artifact body generation 可旧于当前 status/homepage runtime generation，导致 artifact 存在但被视为过期。

修复：

- current artifact continuation touch `homepage:artifact.updated_at`。
- artifact readers 对 artifact rows 使用 `updated_at` 计算 freshness。
- body/snapshot 仍按 stored `generated_at` 做一致性验证。

相关 commits：

```txt
395fe53 fix(worker): keep current homepage artifact warm
93cfdb1 fix(worker): serve touched homepage artifacts
```

### 4.7 正常 scheduled logs 应可关闭

最终发布 profile 包含：

```toml
UPTIMER_SCHEDULED_REFRESH_LOGS = "0"
```

经验：

- 普通 scheduled summary / continuation logs 增加 hot path overhead。
- warnings/errors 仍保留。
- diagnostics flags 不应在最终 CPU 采样中开启。

---

## 5. 被拒绝的方案

### 5.1 `UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED`

该 flag 曾尝试让 homepage fragments 从 runtime snapshot 刷新，以提升 homepage/artifact body generation freshness。

相关 commits：

```txt
6afa702 perf(worker): seed homepage fragments from runtime snapshot
2a79fe9 fix(worker): keep runtime homepage seed generation stable
```

测试结果失败：

```txt
tmp/perf-10ms/dev-tail-deep-split-iter4-stable-runtime-seed-20260429134817.jsonl
BAD_OR_GE10 count=4
continuation max=15ms
exact 10ms samples=3
```

结论：

```txt
不要把 UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED 放入正式发布 profile。
```

该 flag 仍应保持 default-off。它可能作为未来优化实验保留，但不是当前 release profile。

### 5.2 更小 / 更大 check batch size

经验：

- batch size `1`：wrapper overhead 变差。
- batch size `3/4`：child check-batch CPU 变差。
- 当前发布 profile 维持：

```toml
UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = "2"
```

### 5.3 Monolithic homepage refresh

仍不适合作为 scheduled sharded path：

```txt
POST /api/v1/internal/refresh/homepage
```

经验：

- 它太容易超过 10ms CPU。
- 最终方案明确使用：
  - sharded fragments
  - raw assembly
  - pre-rendered artifact monitor fragments
  - continuation

---

## 6. 重要证据时间线

### 6.1 失败 baseline

```txt
tmp/perf-10ms/dev-tail-artifact-final-soak-20260429105720.jsonl
BAD_OR_GE10 count=4
cron max=12ms
check-batch exact 10ms
```

```txt
tmp/perf-10ms/dev-tail-artifact-final-concurrency1-long-20260429112012.jsonl
BAD_OR_GE10 count=4
check-batch max=31ms
cron max=24ms
continuation max=16ms
```

### 6.2 Trusted scheduler lease short pass

```txt
tmp/perf-10ms/dev-tail-deep-split-iter2-trust-lease-20260429114722.jsonl
BAD_OR_GE10 count=0
cron max=6ms
check-batch max=3ms
continuation max=4ms
writer max=1ms
```

### 6.3 Medium pass

```txt
tmp/perf-10ms/dev-tail-deep-split-iter3-medium-20260429115803.jsonl
BAD_OR_GE10 count=0
cron max=8ms
check-batch max=4ms
continuation max=5ms
writer max=1ms
```

### 6.4 Iteration 4 rehearsal pass

```txt
tmp/perf-10ms/dev-tail-deep-split-iter4-rehearsal-20260429124702.jsonl
BAD_OR_GE10 count=0
cron max=7ms
check-batch max=4ms
continuation max=6ms
writer max=1ms
```

### 6.5 Rejected runtime homepage seed failure

```txt
tmp/perf-10ms/dev-tail-deep-split-iter4-stable-runtime-seed-20260429134817.jsonl
BAD_OR_GE10 count=4
continuation max=15ms
```

### 6.6 Final profile rehearsal pass

```txt
tmp/perf-10ms/dev-tail-deep-split-iter4-final-candidate-20260429135630.jsonl
BAD_OR_GE10 count=0
cron max=7ms
check-batch max=4ms
continuation max=4ms
writer max=1ms
```

### 6.7 Final long pass

```txt
tmp/perf-10ms/dev-tail-deep-split-iter5-final-long-20260429140817.jsonl
BAD_OR_GE10 count=0
cron max=9ms
check-batch max=4ms
continuation max=6ms
writer max=1ms
```

---

## 7. Verification 已通过

本轮相关 commits 后通过：

```bash
pnpm --filter @uptimer/worker typecheck
pnpm --filter @uptimer/worker lint
pnpm --filter @uptimer/worker test
pnpm --filter @uptimer/worker test:cron
```

最终 full worker / cron：

```txt
worker test: 47 files / 459 tests passed
test:cron: 42 tests passed
```

Web UI/UX earlier verification：

```bash
pnpm --filter @uptimer/web typecheck
pnpm --filter @uptimer/web lint
pnpm --filter @uptimer/web build
```

UI/UX QC 修复已完成，public API / preload behavior 未被最终 CPU 工作破坏。

---

## 8. 当前 commit / Dev 状态

当前本地 / Dev HEAD：

```txt
2a79fe9 fix(worker): keep runtime homepage seed generation stable
```

重要 commits：

```txt
99efb7a perf(worker): trust scheduler lease for check batches
395fe53 fix(worker): keep current homepage artifact warm
6afa702 perf(worker): seed homepage fragments from runtime snapshot
93cfdb1 fix(worker): serve touched homepage artifacts
2a79fe9 fix(worker): keep runtime homepage seed generation stable
```

说明：

- `2a79fe9` 包含 runtime homepage seed flag 代码，但该 flag 是 default-off。
- 最终 release profile 不启用 `UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED`。
- Dev CI / Deploy green。
- 未 push `origin`。

---

## 9. Release 后运维事项

### 9.1 已采用的发布方式

PR #77 先合入已验证代码与 release readiness 文档；PR #78 再将已验证 Free Plan CPU profile 写入 `apps/worker/wrangler.toml`，使默认部署使用同一组实测通过的 flags。

### 9.2 后续 Production rollout / 变更仍必须 Tail 验证

后续任何影响 release profile flags、scheduled path、public snapshot path 的变更，都不能只依赖 Dev 结果。Production 开启或调整后至少需要：

```txt
BAD_OR_GE10 count=0
no exact 10ms
no refresh/homepage fallback
no Subrequest depth
no HTTP 500
public parity OK
```

### 9.3 哪些 flags 可考虑未来默认化

已发布但仍需谨慎的关键 flags：

- `UPTIMER_SHARDED_ASSEMBLER_MODE=json`
- `UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT=1`
- `UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE=1`
- `UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES=1`

其中最高风险是：

```txt
UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE
```

因为它跳过 child lock，依赖 scheduler lease 和 deterministic chunking。

### 9.4 哪些必须保持禁用

```txt
UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED
UPTIMER_SHARDED_CONTINUATION_DIAGNOSTICS
UPTIMER_INTERNAL_CHECK_BATCH_DIAGNOSTICS
UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY
```

---

## 10. Release checklist 结果

- [x] Main repo 通过 PR 合并（#77、#78），未直接 push `master`。
- [x] Dev repo 已同步到 Main release HEAD。
- [x] D1 migration `0012_public_snapshot_fragments.sql` 已随部署应用。
- [x] Production `.toml` 使用已验证 flags，未包含临时 diagnostics。
- [x] Final release flags 中不包含 `UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED`。
- [x] Production Tail 已运行。
- [x] Tail 结果 `BAD_OR_GE10 count=0`。
- [x] Public route parity 已验证：
  - [x] `/api/v1/public/homepage`
  - [x] `/api/v1/public/status`
  - [x] `/api/v1/public/homepage-artifact`

---

## 11. Rollback 建议

若 production rollout 出现 CPU `>=10ms` 或 public route parity 问题，优先按以下顺序回滚 flags：

1. 关闭 rejected/experimental flags（尤其确认 runtime seed 未启用）：

```toml
UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED = "0"
```

2. 关闭 trusted scheduler lease：

```toml
UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE = "0"
```

3. 关闭 sharded publish / continuation，回到较保守路径：

```toml
UPTIMER_SCHEDULED_SHARDED_CONTINUATION = "0"
UPTIMER_SCHEDULED_SHARDED_PUBLISH = "0"
UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH = "0"
```

4. 恢复 baseline scheduled batch size：

```toml
UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = "2"
```

---

## 12. Final statement

基于 Dev controlled long Tail 与 production post-release Tail：

```txt
tmp/perf-10ms/dev-tail-deep-split-iter5-final-long-20260429140817.jsonl
BAD_OR_GE10 count=0

tmp/perf-10ms/prod-tail-release-issue24-20260429154407.jsonl
BAD_OR_GE10 count=0
```

当前发布基线已在采样范围内满足：

```txt
所有 sampled invocation path CPU 严格 <10ms
```

Issue #24 已通过 PR #77/#78 final close。后续若改动 CPU profile、scheduled path 或 public snapshot path，必须重新 Tail 验证。
