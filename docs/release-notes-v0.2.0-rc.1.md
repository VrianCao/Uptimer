# Uptimer v0.2.0-rc.1

## Highlights

- The status page shows preloaded data and then checks for updates. Latency charts load on demand, keep their animation, and respect the system reduced-motion setting. A failed chart download leaves the status page usable.
- D1 stores complete probe samples in time buckets and buffers the current hour to reduce writes. The default Free runtime uses Workers, a SQLite Durable Object and D1. The optional Paid runtime uses Workers and D1. Workers + Pages remains the default hosting mode, with Workers Assets available as an option.
- Monitor visibility and scope are preserved in history, incidents and maintenance. Same-origin admin authentication and narrow-screen dialog and keyboard behavior were also fixed.
- Reviewed deployment plans bind the build, commit and target resources. The workflow rechecks resource identity before writes, preserves existing secrets and skips completed stages on a matching retry.

## Deployment and verification

The [v0.2.0 deployment and upgrade guide](v0.2.0-upgrade.md) covers fresh installs, upgrade steps, and Agent assistance. For supported `0014` databases, Apply pauses probes and admin writes, migrates the existing D1, and resumes monitoring. See the [upgrade and recovery guide](upgrade-and-recovery.md).

CI covers all four runtime and hosting combinations. The local migration rehearsal preserved 302,400 probe samples across `0014 → 0025`. An isolated Cloudflare rehearsal verified interruption and resume, retention of 1,440 historical samples in the original D1, rejection of old Worker writes and a no-op repeat. After the maintenance snapshot fix, a complete upgrade kept the sampled homepage requests at HTTP 200 and showed the previous snapshot during about 30 seconds of maintenance.

The hosted upgrade used Pages and the `free` runtime profile on a Workers Paid account. Native Free account limits and the GitHub web Sync fork path still need direct verification. In an earlier Dev short run, Pages served 60/60 requests with CPU at most 5 ms, ordinary Worker CPU reached at most 3 ms, and 2,880 expected probes were recorded once each across the deployment window.

In a separate 24-hour observation of an earlier Dev build, 24 monitors at one-minute intervals produced 34,560 probes. D1 recorded 3,388,147 row reads and 55,310 row writes in that window.

## 中文说明

- 首屏展示预载数据并随后检查更新。延迟曲线按需加载，保留动画并尊重系统的减少动态效果设置。图表脚本下载失败时，状态页仍可使用。
- D1 通过时间桶和当前小时缓冲降低写入量，保留完整探测样本。默认 Free 运行模式使用 Workers、SQLite Durable Object 和 D1，可选 Paid 模式使用 Workers 和 D1。默认托管方式是 Workers + Pages，也可使用 Workers Assets。
- 修复了监控隐藏状态与历史、事件和维护范围的处理，并改进同源后台鉴权、窄屏弹窗和键盘操作。
- 部署计划绑定构建包、提交和目标资源。工作流在写入前复核资源身份，保留已有密钥，并在匹配的重试中跳过已完成的阶段。

[v0.2.0 部署与升级指南](v0.2.0-upgrade.zh-CN.md)介绍了首装、升级步骤和如何让 Agent 协助。对于受支持的 `0014` 旧库，Apply 会暂时暂停探测与后台写入，在原 D1 上迁移后恢复监控。详见[升级与恢复指南](upgrade-and-recovery.md)。

CI 覆盖四种运行模式与托管组合。本地演练确认 `0014 → 0025` 保留了 302,400 条探测样本。Cloudflare 隔离演练验证了中断续跑、原 D1 保留 1,440 条历史样本、拒绝旧 Worker 写入，以及完成后重跑不重复迁移或部署。修复维护快照后，完整升级的维护窗口约 30 秒，采样的首页请求均返回 HTTP 200 并显示上一次快照。

云端升级使用 Workers Paid 账户上的 `free` 运行配置和 Pages 托管。真实 Free 账户额度与 GitHub 网页 Sync fork 路径仍待直接验证。此前 Dev 短测中，Pages 60/60 请求成功，CPU 最高 5 ms，普通 Worker 最高 3 ms，部署窗口内 2,880 次预期探测均完整且无重复。

在较早 Dev 版本的独立 24 小时观测中，24 个监控以一分钟间隔产生 34,560 次探测。该窗口内 D1 记录了 3,388,147 行读和 55,310 行写。
