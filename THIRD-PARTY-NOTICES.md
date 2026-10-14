# Third-party notices / 第三方声明

**dsh-whalechan 是社区作品，不是 DeepSeek 官方项目。** "DeepSeek"、"DeepSeek Whale-chan"
及相关名称与标识归其各自权利人所有。本项目与杭州深度求索人工智能基础技术研究有限公司无隶属关系。

本仓库采用**分层许可**（与上游一致）：

| 覆盖范围 | 许可 | 文件 |
| --- | --- | --- |
| 本插件原创代码（`src/` 除下列两处、构建配置与文档） | MIT | [`LICENSE`](LICENSE) |
| 再分发的上游内容与由上游规范派生的部分 | CC BY-NC-SA 4.0 | [`LICENSE-CC-BY-NC-SA-4.0.md`](LICENSE-CC-BY-NC-SA-4.0.md) |

**整个仓库及其再分发内容均不得用于商业用途。**

---

## 1. DeepSeek Whale-chan（上游）

- 仓库：<https://github.com/Neko3000/deepseek-whalechan>
- 作者：Neko3000（Xueliang Chen）
- **比对基准**：本仓库 vendor 的 16 个文件，已与上游 commit
  `4ad216fc5c6e1e59d166ef5e1519d5cca44c600b`（2026-10-03）**逐字节比对，16/16 完全相同**
  （含 15 张 webp 与 `reference-catalog.json`；下表的每个 sha256 都可与上游同名文件对拍）。
  上游后续若改动这些文件，本仓库需要重新比对并在本文件更新这段基准。
- 我们取用了什么：
  - `skills/whalechan-image-character/assets/reference-images/**` → `vendor/whalechan-image-character/assets/reference-images/**`（**15 张，与上游逐字节相同**）
  - `skills/whalechan-image-character/references/reference-catalog.json` → `vendor/whalechan-image-character/references/reference-catalog.json`（**逐字节相同**）
  - `skills/whalechan-image-character/scripts/manage-run.py` 第 50–52 行的三条 canonical 常量
    （`DEFAULT_BACKGROUND` / `DEFAULT_STYLE` / `DEFAULT_COSTUME`）→ `src/domain/compose.ts`，**逐字引用**
  - `skills/whalechan-image-character/references/character-spec.md`、`references/form-profiles.md` 的
    **规范语义** → `src/domain/prompt/character.ts` 里的身份与比例表述（**改写**，其中
    "keep apparent age unchanged" 一句逐字保留）
- **我们这里没有什么：** 上游角色侧**没有 prompt 编译器**（角色 prompt 由 agent 读规范自行组装；
  上游只有漫画侧有 `skills/whalechan-image-comic/scripts/build-prompt.py`，文案与角色侧不同）。
  所以本插件的 `src/domain/prompt/character.ts` **不是上游代码的移植**，而是按上述规范写的确定性实现。
  这段关系只写了这一次，本仓库的编译产物就建立在它之上。
- **上游的许可（2026-10-07 起）**：上游在同一天补上了三份文件并写清了三层范围
  （`ea972d7 docs(license): add licenses and clarify content scopes`，PR #5；
  `422f8e8 docs(readme): fix navigation and license links`，PR #6）：
  1. **MIT** —— `skills/*/scripts/`、`skills/*/tests/` 里的项目原创代码，**含代码常量**
     （上游 `LICENSE`：`Copyright (c) 2026 Neko3000 and contributors`）。上游过去那个指向
     `LICENSE` 的死链，现在有文件了。
  2. **CC BY-NC-SA 4.0** —— 项目原创的 README 文字、`skills/*/SKILL.md`、Markdown 规范与
     提示词/版式模板、`skills/*/agents/` 配置，以及 `skills/*/references/` 里的
     **JSON 规范 / 目录元数据**。
  3. **图片与其他第三方素材：不在以上任何 blanket 授权之内。** 上游写明
     "Catalog metadata does not license the images it describes"，也写明仓库**没有记录
     每张图的原始作者、原始发布地址与再分发/再许可许可**，并写道 "Attribution alone does
     not authorize copying, redistribution, modification, or submission to an
     image-generation service"。
  4. 署名：上游新 README 建议注明出处为 `DeepSeek Whale-chan`（**不带** "Project" 后缀）。
- **授权记录（已收到）**：<https://github.com/Neko3000/deepseek-whalechan/issues/3#issuecomment-6040420103>，
  作者本人（`author_association: OWNER`）于 **2026-10-07 22:44（+0800）** 回复，关键句原文：

  > 我在此正式授权基于本仓库 README 与 Skills 文档改编/整理内容。

  同一回复中，作者要求本项目的署名不带 "Project" 后缀（用 `DeepSeek Whale-chan` 或
  `DeepSeek Whalechan`）—— 上游新 README 现在也这么建议。

  **这份授权的范围以上游自己的记录为准。** 上游 `THIRD-PARTY-NOTICES.md` 的
  "DSH integration permission record" 一节把本 issue 记为：支持本项目集成，并**明确授权
  README 与 Skills 文档的改编/整理**；同时逐字写道：

  > It is not a blanket grant of third-party rights. Redistribution of images and
  > transmission to image-generation services require permissions covering those
  > uses from the relevant rights holders.
- **因此本仓库对三类内容的依据是分开的**（不要把它们当成同一种）：

  | 内容 | 本仓库的依据 |
  | --- | --- |
  | `src/domain/compose.ts` 里逐字引用的三条常量 | 上游**以 MIT 授权其代码常量**，故按 MIT 处理 |
  | `src/domain/prompt/character.ts`（按上游规范改写）、`reference-catalog.json`（上游目录元数据） | 上游的 **CC BY-NC-SA 4.0**：非商业 + 署名 + 相同方式共享 |
  | `vendor/.../assets/reference-images/**` 那 15 张 webp | **上游没有给出 blanket 授权，并把这一用途明确排除在外。** 本仓库在收到作者"请推进"的回复后，以**非商业**方式再分发这 15 张图（逐字节未改、署名保留），并承诺**作者或相关权利人一旦要求即无条件撤下**。若你要把它们用于商业用途、或送往图像生成服务，请自行向相关权利人取得许可 —— 本仓库不能代授 |

## 2. 角色形象与二创著作权归属（上游声明的第三方）

上游 `README.zh.md` 的「角色形象与二创著作权归属」一节声明：部分已知核心形象设定与二创素材来源于以下创作者，
**其原始著作权归原作者所有**：

- B站 **ZipZipPipe** — <https://space.bilibili.com/4168597>
- B站 **上善无形** — <https://space.bilibili.com/4456176>

鲸鱼娘形象的诞生、演进与传播基于广大网友的集体创作。本插件不包含上述创作者的原始作品，但再分发的参考图
源自包含其贡献的角色设定体系，因此这一归属声明必须随本仓库一同保留。上游同时要求关注「其他任何创作者的权利」。

上游自己的 `THIRD-PARTY-NOTICES.md` 对这类链接给了一句更严格的说明，我们照抄它的口径：**这些是署名，
不是许可证据**；上游也没有记录图片与原始作者、原始发布地址之间的逐图对应关系，所以**不要从文件名或哈希
去推断任何授权**。署名本身不构成复制、再分发、修改或送往图像生成服务的授权。

## 3. 运行时依赖（本插件不包含其代码）

| 依赖 | 许可 | 与它的关系 |
| --- | --- | --- |
| [`@dickpy/dsh-imagegen`](https://github.com/dickpy/dsh-imagegen) | Apache-2.0 | 仅通过本机 loopback HTTP 调用其 `/api/dsh-imagegen/*` 路由。**不包含、不修改、也不再分发其任何代码**，因此不构成衍生作品。 |

本插件调用的图像渠道由用户自行配置，产生的费用由用户自付；插件在花钱之前会把将要发送的完整 prompt 与
模型/尺寸交给用户确认。

## 4. 再分发的文件清单（冻结记录）

本节是**冻结记录**，不是生成物：16 个文件的字节数与 SHA-256 取自 `vendor/PROVENANCE.json`，
两者必须一一对应。复核不依赖本仓库的任何脚本 —— 对 `vendor/` 下这 16 个文件逐个算 SHA-256
与本表比对即可；也可以用 `lib/index.js` 导出的 `treeDigest` / `readProvenance` 重算整树摘要。

<!-- vendored-files:begin -->
再分发文件共 **16** 个，合计 **1464597** 字节。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `vendor/whalechan-image-character/assets/reference-images/chibi/0054_rice_identity_comic_rendered_isolated.webp` | 107344 | `d8af9195d0c467e1c6644562d6b17856fc7e9a5f7e35ece3bb0dd8acf49c67ff` |
| `vendor/whalechan-image-character/assets/reference-images/chibi/0057_patting_full_belly_rendered_isolated.webp` | 89366 | `79bbaa343c903f089665a1fd9e7e3a754ca78302ce6223e6374abf1a6b06cbd9` |
| `vendor/whalechan-image-character/assets/reference-images/chibi/0067_angry_you_are_silly_reply_rendered_isolated.webp` | 111830 | `f959fb2267f3d2e5559f2fd80e884e279e7adbce5006deea1b8a9555294086ac` |
| `vendor/whalechan-image-character/assets/reference-images/compact/0080_lounging_on_chair_rendered_isolated.webp` | 125670 | `d6a95aeaf0af8607157c4978dd6033c5de7121f6fc032fc90f7dbe45f089f8e6` |
| `vendor/whalechan-image-character/assets/reference-images/compact/0102_intimate_relationship_question_rendered_isolated.webp` | 95582 | `c730c35ef35b9cb5487a9efe75788f6e5f7c4587dd0df146a6197e104706d6e5` |
| `vendor/whalechan-image-character/assets/reference-images/compact/04_light_turn.webp` | 96850 | `0b3af83e924936e9bbcf7ca8d5aa94eb89f33e23ba83f29eeaa77910713fb8d9` |
| `vendor/whalechan-image-character/assets/reference-images/semi-chibi/0015_data_still_in_brain_rendered_isolated.webp` | 107302 | `13e68609efd9fc6165a784840ddbf6ad3d2b79123ab9c612dcf5e73b74cd2c50` |
| `vendor/whalechan-image-character/assets/reference-images/semi-chibi/0076_sitting_ready_on_chair_rendered_isolated.webp` | 98218 | `430b08eece9680f74fd5af145843441bb88c81e1683ffe04a951860d8137dbe6` |
| `vendor/whalechan-image-character/assets/reference-images/semi-chibi/0092_enduring_release_delay_rendered_isolated.webp` | 92334 | `8ff24bbde6ed8b4628d3472507fa22349242f5c750c06eca14ac1e7bc37a3b34` |
| `vendor/whalechan-image-character/assets/reference-images/standard/01_gentle_wave.webp` | 103678 | `a090bd51056da8fac49128a570a9f071f86768008c546e9391ed6cef015e66fc` |
| `vendor/whalechan-image-character/assets/reference-images/standard/03_light_turning_step.webp` | 85436 | `d85ac019e63f18e983d100d022f9f44db533cee2fa0a7f44872a12f71e288325` |
| `vendor/whalechan-image-character/assets/reference-images/standard/05_side_reclining_pose.webp` | 92114 | `ef875731ca641c8b0a4f6cfff33a9301ede00d0b4b168e56a0e543b085d524f4` |
| `vendor/whalechan-image-character/assets/reference-images/super-deformed/0019_literal_love_reply_rendered_isolated.webp` | 83664 | `19c50e5373285a7cb834de2b9990b955e4f34d4e49facf7100a7fffe18cc9b77` |
| `vendor/whalechan-image-character/assets/reference-images/super-deformed/0040_kicked_from_chair_rendered_isolated.webp` | 97850 | `f89f34211c97b246b95ce7cca13d951bfbe52c5c6dbd9c27da44e99fedc48a94` |
| `vendor/whalechan-image-character/assets/reference-images/super-deformed/0081_stranded_on_floor_rendered_isolated.webp` | 71780 | `f968de20110f6a8830172e7899f5529a8f1331c587f4cfd72b3ddd6059d6a869` |
| `vendor/whalechan-image-character/references/reference-catalog.json` | 5579 | `61a449f92f74bc67a5d2f997c75fb4c90776230bbd06d0f90abe4e407fe38346` |

本 vendor 树的摘要（口径见 `vendor/PROVENANCE.json` 的 `covers`；路径相对本树根）：`8e9a018d50ab2220c0140048ce50f00f225a6e4b08bf1be7cbb0c722bc7e6ac4`

`vendor/PROVENANCE.json` 自身的摘要（对上面这些记录再哈希一次，动任何一处都会变）：`490863ea1862c79d28790e8acb0862c5551f6ac5e7974144d468e430e3574b90`

上游对应位置：`skills/whalechan-image-character/`（本机冻结来源：`../dsh-whalechan/.dsh/skills/whalechan-image-character`）。
<!-- vendored-files:end -->
