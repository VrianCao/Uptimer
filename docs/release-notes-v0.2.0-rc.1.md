# Uptimer v0.2.0-rc.1

## Highlights

- The status page shows preloaded data and then checks for updates. Latency charts load on demand, keep their animation, and respect the system reduced-motion setting. A failed chart download leaves the status page usable.
- D1 stores complete probe samples in time buckets and buffers the current hour to reduce writes. The default Free runtime uses Workers, a SQLite Durable Object and D1. The optional Paid runtime uses Workers and D1. Workers + Pages remains the default hosting mode, with Workers Assets available as an option.
- Monitor visibility and scope are preserved in history, incidents and maintenance. Same-origin admin authentication and narrow-screen dialog and keyboard behavior were also fixed.
- Reviewed deployment plans bind the build, commit and target resources. The workflow rechecks resource identity before writes, preserves existing secrets and skips completed stages on a matching retry.

## Deployment and verification

Use the [deployment guide](deploy-github-actions.md) for a fresh install or an existing database with all migrations already applied. **Upgrades from the `0014` schema are gated.** The workflow stops an apply to an existing Worker when migrations are pending. Put those upgrades through a separate cloud maintenance and recovery rehearsal. See the [upgrade and recovery guide](upgrade-and-recovery.md).

CI passed for all four runtime and hosting combinations. The local migration rehearsal preserved 302,400 probe samples across `0014 → 0025` and recovered from interruptions. In the final Dev short run, Pages served 60/60 requests with CPU at most 5 ms, ordinary Worker CPU reached at most 3 ms, and 2,880 expected probes were recorded once each across the deployment window. The Dev tests used the Free runtime profile on a Workers Paid account. Hard limits on a Free account and the legacy cloud upgrade remain to be verified.

In a separate 24-hour observation of an earlier Dev build, 24 monitors at one-minute intervals produced 34,560 probes. D1 recorded 3,388,147 row reads and 55,310 row writes in that window.

## 中文说明

- 首屏展示预载数据并随后检查更新。延迟曲线按需加载，保留动画并尊重系统的减少动态效果设置。图表脚本下载失败时，状态页仍可使用。
- D1 通过时间桶和当前小时缓冲降低写入量，保留完整探测样本。默认 Free 运行模式使用 Workers、SQLite Durable Object 和 D1，可选 Paid 模式使用 Workers 和 D1。默认托管方式是 Workers + Pages，也可使用 Workers Assets。
- 修复了监控隐藏状态与历史、事件和维护范围的处理，并改进同源后台鉴权、窄屏弹窗和键盘操作。
- 部署计划绑定构建包、提交和目标资源。工作流在写入前复核资源身份，保留已有密钥，并在匹配的重试中跳过已完成的阶段。

全新安装，以及已应用全部迁移的实例，可按[部署指南](deploy-github-actions.zh-CN.md)操作。**旧库 `0014 → 0025` 升级有独立门槛。** 已有 Worker 存在待执行迁移时，工作流会停止 apply。此类升级须先完成独立的云端维护与恢复演练。详见[升级与恢复指南](upgrade-and-recovery.md)。

CI 的四种运行模式和托管组合均通过。本地迁移演练保留了 302,400 条探测样本，并验证了中断后的恢复。最终 Dev 短测中，Pages 60/60 请求成功，CPU 最高 5 ms，普通 Worker 最高 3 ms，部署窗口内 2,880 次预期探测均完整且无重复。Dev 使用的是 Workers Paid 账户上的 Free 运行模式。真实 Free 账户强制限额及旧库云端升级仍待验证。

在较早 Dev 版本的独立 24 小时观测中，24 个监控以一分钟间隔产生 34,560 次探测。该窗口内 D1 记录了 3,388,147 行读和 55,310 行写。
