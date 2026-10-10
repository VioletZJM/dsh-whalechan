# dsh-whalechan

DeepSeek Harness 插件：**说一句场景，画一张鲸鱼娘**。

一个工具，两次调用。它在**花钱之前**把将要发送的 prompt 全文、用的模型、能交付的尺寸和一个
`plan_id` 摆给你看；你点头之后才出图。图落地的一瞬间，**插件自己把它交到你手上** —— 模型收到的
交付消息只有一行、不含文件路径。**没有任何自动检查对这张画下判断**，好不好看是你的判断。

> **非官方项目。** 这是社区作品，不是 DeepSeek 官方产物；"DeepSeek" 及相关名称归其各自权利人所有。
>
> **分层许可，且不得商用。** 本插件原创代码是 MIT；`reference-catalog.json` 与由上游规范派生的
> prompt 编译器是 **CC BY-NC-SA 4.0**；而那 **15 张参考图不在上游任何 blanket 授权之内** —— 上游
> 自己的声明明确把图片排除在 MIT 与 CC 之外。三者依据不同，分别写在
> [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) §1（含逐文件 sha256），许可正文见
> [`LICENSE`](LICENSE) 与 [`LICENSE-CC-BY-NC-SA-4.0.md`](LICENSE-CC-BY-NC-SA-4.0.md)。

---

## 1. 它做什么

- **一个工具**：`whalechan_image({ prompt, form?, ratio?, count?, model?, plan_id?, confirm? })`。
  你说场景，角色身份、画风、服装、比例、构图由插件内部编译，不用你写。
- **干跑免费**：不带 `confirm` 调用，返回**将要逐字发送的完整 prompt**、模型、能交付的比例、
  预期像素和一个 `plan_id`。
- **确认才花钱**：`plan_id` 绑定「编译后的 prompt + 模型 + 尺寸」。第二次调用与第一次不一致，会在
  **发送之前**被拒绝，一分钱不花。
- **图自己送到你眼前**：出图后插件把文件声明成本轮的交付物，你当场拿到它；模型看不到文件路径，
  也没有第二步要做。
- **没有自动 QA**：不量头身比、不叠加地标、不判合格与否。图好不好看，是你说了算。

## 2. 装进 DSH

### 2.1 前置

| 需要 | 说明 |
| --- | --- |
| **DeepSeek Harness** | 桌面端或 web 端都行 |
| **dsh-imagegen 插件** | 图像渠道与 API Key 都在它那儿配。本插件通过 loopback HTTP 调它的路由，自己不碰密钥 |
| **Node** | DSH 自带的就够（本插件不需要 Python、不需要 ImageMagick） |
| **pnpm** | 用来装依赖与打包；DSH 自带一份 |

### 2.2 拿源码、构建、打包

```powershell
git clone https://github.com/VioletZJM/dsh-whalechan.git
cd dsh-whalechan

pnpm install                 # 装依赖
pnpm build                   # 构建 lib/index.js（仓库里不含构建产物）
pnpm test                    # 可选：196 条测试
pnpm verify:bundle           # 可选：确认产物能挂载、干跑能编译

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version   # 版本号别手写
pnpm pack --pack-destination .
```

### 2.3 装进 profile

```powershell
# dsh 在 PATH 上时直接用 dsh；桌面端也可以用它自带的那份：
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "file:$PWD\dsh-whalechan-$version.tgz"
```

`web` / `tui` 等其它 profile 同理，把 `desktop` 换掉即可。

> **用 `file:`（tarball），不要用 `link:`。** 桌面端从 `~\.dsh\profiles\node_modules` 解析框架包，
> `link:` 会让插件改从源码目录加载**另一份** `dsh-tools`，同一个进程里就有两份框架。
>
> **那个 `.tgz` 不要删、不要挪。** 它的路径写进了 profile 的 `package.json`，是那个 profile 的**硬依赖**：
> 文件不在，之后该 profile 里任何 pnpm 操作都会失败。升级 = 打新包 → `add` 新路径 → 确认新包装上 → 再删旧包。

### 2.4 重启宿主

**必须重启。** 插件模块按真实路径缓存，只换磁盘上的文件不会重新加载。

### 2.5 （可选）给它设默认模型

bundle 插入的行没有 config，要设默认模型就在 profile 的 `cordis.patch.yml` 里**按 id 覆盖**
（不要再写一个 `insert`，那会插出第二行）：

```yaml
- id: whalechan
  config:
    defaultModel: qwen-image-3.0
```

### 2.6 确认它真的加载了

插件每次挂载都会写一份回执：

```
%USERPROFILE%\.dsh\dsh-whalechan\state\loaded.json
```

里面的 `delivery: true` 是**"图片会不会自己送到你眼前"**的活证据 —— 它记的是宿主有没有把
`sessionProjections` 接上。同一个值也在只读状态路由 `GET /api/dsh-whalechan/status` 里。为 `false`
时插件仍然能出图，只是交付结果里会打印文件路径，由你去把它找出来。

## 3. 唯一的一个工具

| 参数 | 说明 |
| --- | --- |
| **`prompt`** | 场景，用你自己的话。它**逐字**成为 prompt 的 scene 行 —— 角色、风格、服装是插件的事 |
| `form` | 目录里的形式名（`standard` / `compact` / `semi-chibi` / `chibi` / `super-deformed`），或头身数如 `3`。**数字照字面取 3.0**，只有身份锚图取最近的形式。默认 `semi-chibi`（2.8 头身） |
| `ratio` | 渠道能精确交付的比例，如 `1:1`（默认）、`4:7`。干跑会列出全部 |
| `count` | 画几张，每张都是一次计费的生成 |
| `model` | dsh-imagegen 里的模型别名，省略则走默认链 |
| `plan_id` | 干跑返回的那个，`confirm: true` 时必须带上 |
| `confirm` | `true` 会真的花钱 |

**两次调用，一次花钱：**

```
① whalechan_image({ prompt: "坐在地上吃一碗白米饭，笑眯眯的", form: "3头身" })
      → 免费。返回编译好的 prompt 全文、模型、尺寸、plan_id，以及这一下最多花几张
② 人看过、同意
③ whalechan_image({ prompt: …, form: "3头身", confirm: true, plan_id: "…" })
      → 出图。插件立刻把文件声明成本轮交付物；模型的交付消息只有一行
      文件与 sidecar（prompt / 模型 / form / 比例 / 尺寸 / sha256）仍写到磁盘
```

图片默认写到 `%USERPROFILE%\.dsh\dsh-whalechan\images\`（可用 `dataRoot` 配置改）。**正常情况下
模型看不到这个路径** —— 路径只在交付声明失败时才出现在结果里（`delivery_error`），因为那时图片
已经花钱画好了，找不到它才是真的失败。

## 4. 运行前提

| 依赖 | 说明 |
| --- | --- |
| **dsh-imagegen** | 必须装；渠道与密钥配在它那儿 |
| **Node** | DSH 自带的即可 |
| **Python** | **运行时不需要。** 产物里没有任何子进程调用；`python-compat` 只是 Python 数值/字符串行为的移植层，和解释器无关 |
| **ImageMagick** | 不需要 |

## 5. 自己验一遍（七条闸门）

```powershell
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm verify:bundle
pnpm check:exports
pnpm vendor:check
pnpm verify:notices
pnpm verify:install desktop     # 需要先把这个插件装进 desktop profile
```

| 闸门 | 它证明什么 | 期望 |
| --- | --- | --- |
| `typecheck` | 类型是全的 | 退出码 0 |
| `test` | 单元测试 + 与移植来源 Python 实现的差分 | 有那份 Python 时 `196 tests / 196 pass / 0 fail`；没有时**差分那部分干净跳过，不会有失败** |
| `verify:bundle` | **打包产物**能挂载、干跑能编译、且不含退役代码 | `bundle verification passed` |
| `check:exports` | 没有「写了但没接上」的导出 | `8 unplugged, all explained` |
| `vendor:check` | 冻结的参考图与目录没被动过 | `vendor: provenance matches` |
| `verify:notices` | **再分发面与声明一致**：16 个上游文件逐个列在 NOTICES 里、必署名的 9 个名字都在、许可文件存在、包不再声明 private | `notices verification passed` |
| `verify:install` | **装进 profile 的那一份**就是过闸门的这一份，且它**不会解析到自己的框架副本**。框架包是宿主的（peer dependency，桌面端那份在 `app.asar` 里，纯 Node 读不到），Node 解析不到时由 `tools/framework-supply.mjs` 供给本仓库自己钉住的那一份，并在输出里写明用了哪一份 | `install verification passed` |

**差分测试用的是"移植来源"的那份 Python，不是上游脚本。** 它证明的是**本仓库的 TypeScript 编译器与
我们当初移植它的那份 Python 实现逐字节一致** —— 一个防止移植过程悄悄漂移的回归锁。它**不能**证明与
上游一致，因为**上游角色侧根本没有 prompt 编译器**（那边由 agent 读规范文档自行组装；上游只有漫画侧
有 `build-prompt.py`，文案与角色侧不同）。那份 Python 也不在本仓库里 —— 它在一个 DSH 技能目录里，
测试按 `../dsh-whalechan/.dsh/skills/whalechan-image-character` 解析（见 `test/support/oracle.ts`）：
在这份仓库的**上一级**放一个名为 `dsh-whalechan` 的目录、里面是那棵技能树，再用 `WHALECHAN_PYTHON`
指向能运行它的解释器。做不到也没关系 —— 那部分会跳过，其余测试照常。

几条设计上的取舍，因为它们都是被真实事故换来的：

- **`verify-install` 是六条本地闸门查不到的东西。** 这个项目被它抓到过两次：`link:` 装法让插件
  加载了第二份 `dsh-tools`；改了内容但没改 tarball 名，pnpm 说 "Already up to date"，于是**所有
  本地闸门全绿而宿主加载着旧的构建**。
- **`verify:notices` 管的是唯一会静默出错的一类问题**：多了一个没人声明的再分发文件、少了一个
  必署名的人。所以再分发文件清单是**从 `vendor/` 目录生成**的（不手写），`--check` 拿生成结果与
  提交的文件逐字对比。它自己也被负向验过：往 `vendor/` 多放一个文件 → 红，删掉 NOTICES 里的
  `ZipZipPipe` → 红，把 `private: true` 写回去 → 红。
- **`tools/run-timeline.mjs`** 是量"一次交付到底花在哪"的尺子：读 DSH 的会话记录，逐条算步数、
  每个工具的耗时、每一步要重读多少上下文，并且能只量一个 turn：

  ```powershell
  node tools/run-timeline.mjs <会话 id 片段> --last-turn
  ```

## 6. 已知限制（诚实清单）

| # | 事 | 说明 |
| --- | --- | --- |
| 1 | 出图用的是**参考图编辑**模式（身份锚图随每次请求发送） | 这是角色一致性的来源；渠道必须支持参考图 |
| 2 | prompt 编译器的上限是 **800 字符**，不是渠道的 4000 | 上游冻结引擎的行为，身份块按它定尺寸；超了在**花钱之前**拒绝 |
| 3 | `canonicalJson` 分不清 `4` 与 `4.0` | JavaScript 只有一种数字。`plan_id` 只覆盖字符串与整数，碰不到这个边界；有具名测试钉住 |
| 4 | 真实付费验证是**抽样**的 | 记账闭环与出图路径有离线测试与假宿主覆盖，真实渠道只跑过少数几次 |
| 5 | **不做自动质检** | 这是刻意的：上游那套 14 门禁的视觉 QA 会判一张用户自己满意的图 FAIL。要不要重画，由你决定 |
| 6 | 没有客户端 UI | 只有工具面与一个只读状态路由；交付靠会话自带的交付卡片 |
| 7 | 交付卡片是**文件卡**，不是内联大图 | 想让它直接在对话里铺开像素，需要给插件加一个客户端半边（向 `tool.call.toolview` 注册 `whalechan_image`），目前没有做 |
| 8 | **15 张参考图的授权状态是未闭合的** | 上游 2026-10-07 起明确把图片排除在 MIT 与 CC 之外，并声明图片的再分发与"送往图像生成服务"需要相关权利人许可；作者本人只授权了 README 与 Skills 文档的改编整理。本仓库按非商业方式再分发、逐字节未改、署名保留，并承诺权利人要求即撤下 —— 详见 `THIRD-PARTY-NOTICES.md` §1 |

## 7. 目录结构

```
src/domain/     场景 → 编译器输入的装配、比例与几何表、图像头解析、Python 数值行为移植
src/domain/prompt/   prompt 编译器（按上游角色规范写的确定性实现，与移植来源的 Python 版逐字节差分）
src/run/        dsh-imagegen 客户端、端点解析、计划摘要、数据目录、交付接缝、vendor 溯源
src/tools/      唯一那个工具
src/routes.ts   只读状态路由
test/           单元测试 + 与移植来源 Python 实现的差分测试
tools/          七条闸门与一把尺子
vendor/         上游冻结的一小部分：目录 + 15 张参考图（授权范围分三种，见 THIRD-PARTY-NOTICES.md §1）
```

## 8. 来源与许可

**分层许可：**

| 覆盖范围 | 许可 | 文件 |
| --- | --- | --- |
| 本插件原创代码（`src/` 除 `domain/prompt/character.ts`、`test/`、`tools/`、构建配置与文档） | MIT | [`LICENSE`](LICENSE) |
| `domain/compose.ts` 里逐字引用的三条上游常量 | 上游**以 MIT 授权其代码常量**，故仍为 MIT | 同左 |
| 由上游规范派生的 prompt 编译器 + 上游目录元数据 `reference-catalog.json` | CC BY-NC-SA 4.0 | [`LICENSE-CC-BY-NC-SA-4.0.md`](LICENSE-CC-BY-NC-SA-4.0.md) |
| `vendor/` 里那 15 张参考图 | **不在上游 blanket 授权内**（见下方来源表与 NOTICES §1） | —— |

**整个仓库及其再分发内容均不得用于商业用途**（NC），且再分发必须署名并以相同协议共享（BY / SA）。
完整的第三方声明与逐文件 sha256 清单见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

| 来源 | 关系 |
| --- | --- |
| [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan) | 上游角色规范。`vendor/whalechan-image-character/` 是它**冻结的一小部分**：`reference-catalog.json` + 15 张参考图（**与上游 commit `4ad216fc…` 逐字节相同**，见 `THIRD-PARTY-NOTICES.md` 的摘要）。prompt 编译器**不是**上游代码的移植 —— 上游角色侧没有编译器（那边由 agent 读规范文档组装），我们这层是按它 `references/character-spec.md`、`form-profiles.md` 写的确定性实现，并逐字引用了它 `manage-run.py` 里的三条 canonical 常量。**上游已于 2026-10-07 补上许可证**（`LICENSE` MIT / `LICENSE-CC-BY-NC-SA-4.0` / 它自己的 `THIRD-PARTY-NOTICES.md`），并明确三层范围：代码与代码常量 MIT、规范文档与 JSON 目录元数据 CC-BY-NC-SA 4.0、**图片不在任何 blanket 授权内**。作者本人已于同日回复授权（[issue #3](https://github.com/Neko3000/deepseek-whalechan/issues/3#issuecomment-6040420103)），但**授权的范围以上游自己的记录为准** —— 详见 `THIRD-PARTY-NOTICES.md` §1 |
| B站 [ZipZipPipe](https://space.bilibili.com/4168597) / [上善无形](https://space.bilibili.com/4456176) | 上游 README 声明"部分已知核心形象设定与二创素材"的原始著作权归这两位创作者。本插件不含其原始作品，但再分发的参考图源自包含其贡献的设定体系 |
| [dickpy/dsh-imagegen](https://github.com/dickpy/dsh-imagegen) | 运行时对端（Apache-2.0）。插件只通过 loopback HTTP 调它的路由，**不含也不改它的代码**，因此不是衍生作品 |
| 本插件自身 | 编排层、工具面、计划闸门、交付接缝、差分测试与七条闸门是原创（TypeScript） |
