# enable-qoder-shared-target 手测清单

> 2026-08-22。自动化：Rust `cargo test --lib qoder` 81 绿；focused Vitest helpers/identity/history/sessionIndex 162 绿。
> 下列全部在**同一工作区**测。Global = Qoder Global，CN = Qoder CN。

## A. Native 双分发

1. 侧栏「新会话」只有一个 **Qoder CLI** 父入口，展开有 Global / CN，没有两个顶层 Qoder。
2. 各建一条 Native Global、一条 Native CN。两条可并存，标题/徽章分得开。
3. 打开 Global 会话，模型选择器只有 Global ACP 目录；切到 CN 会话，目录换成 CN。切会话时**不要**转圈拉 catalog。
4. 供应商设置页同一 Qoder 页两张卡：安装路径、登录、PAT 互不影响。
5. 历史会话打开仍绑在创建时的 distribution；改全局设置不得把旧会话改道。

## B. Shared 准入与发送

6. Shared 四级 picker 里 Qoder 可选，不再 disabled。
7. 选 Qoder 必须显式 Global 或 CN（不要落到 `__local_qoder__`）。
8. 新 Shared 发一轮 Global：主幕有 Qoder Global 徽章，回答正常。
9. 同一条 Shared 再发 CN：主幕仍是这一条 Shared，徽章切到 Qoder CN。
10. 再切 PI 或 Grok 发一轮，再切回 Global：上下文还在（user-channel），不必重讲上一轮事实。
11. 连续两轮同一 distribution（不切引擎）：第二轮是续跑，不是另开一条。

## C. 侧栏不漏 Native（已修过，回归）

12. Shared 里 `3+3` Grok → `1=1` Qoder Global：侧栏**只有** Shared 行，没有同名 Grok/Qoder 顶栏，Qoder 也不挂在 Grok 下面。
13. Shared 连发 Global → CN → PI：侧栏仍只有 Shared。
14. 用户自己建的 Native Global / CN / Grok **还在**，没被误藏。
15. 冷启等 2～8 秒：不先闪崽再藏；Shared-owned 行不要冒出来。

## D. 幕布四件套（真实 Shared × Qoder）

16. Streaming 光标跟着正文走。
17. Reasoning 可折叠，不和正文抢气泡。
18. Tool 块出现、完成态正确。
19. 切走再点回来，历史和 live 一致（badge / 工具 / 思考）。

## E. 停止 / 恢复

20. Shared Qoder 生成中点 Stop：尽快停，无迟到大段正文。
21. Stop 后再发「继续」：还在同一条 Shared，绑回同一 distribution。
22. Native CN 点 Stop：不得误停 Global（反之亦然）。

## F. 失败边界（有条件）

23. CN 未登录 / 不可用时，picker **不要**显示 Global 模型目录。
24. 未知 / 损坏的 Qoder identity 应报错，不要默默当成 Global。

## 不测

- 第三个 Qoder 地区、remote/SDK、Qoder 专属 usage 卡、`session.tree`
- `src/features/update/generated/**` 版本说明
