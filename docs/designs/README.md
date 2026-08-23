---
type: index
status: active
---

# Designs

本目录是可入库设计稿的 canonical 位置：HTML 原型、选款页、视觉 mock。它们用于拍板与对照，不是 shipped UI，也不是 OpenSpec / `dev-guidelines` 的事实源。

落地后若行为进入产品，以代码和 OpenSpec 为准；本目录只保留对照稿。

| 稿件 | 用途 | 打开方式 |
|---|---|---|
| [`loading-picker/index.html`](loading-picker/index.html) | 「响应中」loading 25 选 1（01–10 几何 / 11–25 意象）；生产仍是 Mac `03` / Windows `10` | 浏览器打开 gallery |
| [`session-loading/index.html`](session-loading/index.html) | 切换会话画布幕布第一轮（保留 03 / 04 / 10） | 浏览器打开 gallery |
| [`session-loading/r2/index.html`](session-loading/r2/index.html) | 第二轮 10 稿：换几何（日食 / 底栏 / 竖脊 / 握手 / 地平线 / 仪表 / 星座 / 扫光 / 双月 / 大字） | 浏览器打开 gallery |
| [`curtain-reveal/index.html`](curtain-reveal/index.html) | 加载幕布拉开：各方向 + Mac/Win 兼容分层 | 浏览器打开，点卡片重播 |
| [`dsh-vendor-settings/DSH Vendor Settings.html`](dsh-vendor-settings/DSH%20Vendor%20Settings.html) | DSH vendor 连接面板方案 A | 浏览器打开 |
| [`git-operation-panels/index.html`](git-operation-panels/index.html) | Git 拉取 / 推送 / 同步 / 获取 / 刷新确认框第二轮：03 内容 × 05 外观，A / B 两套 | 浏览器打开 gallery，再点进 A 或 B |
| [`git-operations-r3/index.html`](git-operations-r3/index.html) | Git 操作弹窗第三轮（含创建 PR）：V1 Inspector / V2 Primer / V3 Command Ledger / V4 IDE Light / V5 Wizard Steps，每稿画全 5 个弹窗 | 浏览器打开 gallery 选款 |
| [`sidebar-pinned-fold/index.html`](sidebar-pinned-fold/index.html) | 侧栏置顶按 `yyyy-mm-dd` 分组：日期头做最外层，不要今天/昨天/更早 | 浏览器打开，点日期头 |
| [`fluid-motion-presets/index.html`](fluid-motion-presets/index.html) | 流体背景动势五选：流动 / 太极 / 暴风雨 / 龙卷风 / 游走（双龙，配色正交，含深灰白，工作台减速） | 浏览器打开，点卡片或芯片切换 |
| [`shared-provider-retry/index.html`](shared-provider-retry/index.html) | Shared 供应商失败后同一家再发一轮：倒计时 / 立即再试 / 停止，可改次数、等待和话术 | 浏览器打开，点右侧失败类型和设置 |
| [`runtime-model-identity/05-receipt-r-mark.html`](runtime-model-identity/05-receipt-r-mark.html) | 采纳稿 B：Shared turn badge 前半 picker 不动；后半高亮 `→` + 圆形 R + runtime 模型/窗口 | 浏览器打开，点回执下滑 |
| [`prompt-enhancer-redesign/index.html`](prompt-enhancer-redesign/index.html) | Composer「增强提示词」方案 A 定稿：并排对照；引擎只显示供应商设置已启用 CLI（`disabledCliEngines`） | 浏览器打开，左侧模拟启停引擎，再点开始增强 |
| [`pi-native-features/index.html`](pi-native-features/index.html) | Pi 接入设计稿（真壳 base：真实 CSS @import + 运行时 DOM dump）：4 共同分叉（mossx 级 fork UX）/ 1 侧栏树 / 2 沉浸树 / 3 内嵌分叉；跨引擎调研见 `docs/research/session-fork-tree-cross-engine-capability.md`；幕布不动 | 浏览器打开 gallery |
| [`qoder-distribution-options.html`](qoder-distribution-options.html) | Qoder CLI Global / CN 的客户端身份形态对照：A 双入口（推荐）与 C 单入口地区切换 | 浏览器打开，点击 Global / CN 对比会话身份 |
| [`qoder-distribution-options-v2.html`](qoder-distribution-options-v2.html) | Qoder CLI 单父入口、双分发子入口：新建会话菜单子菜单 + 同页 Global / CN 供应商配置 | 浏览器打开，点击 Qoder CLI、Global / CN 或管理按钮 |

存量 `docs/previews/`、`docs/prototypes/` 因高 fan-out 引用暂不搬迁。新设计稿一律进本目录，不要放仓库根 `designs/` 或 `.artifacts/`。

上级导航：[`../README.md`](../README.md)
