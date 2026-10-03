# Third-party notices / 第三方声明

**dsh-whalechan 是社区作品，不是 DeepSeek 官方项目。** "DeepSeek"、"DeepSeek Whale-chan"
及相关名称与标识归其各自权利人所有。本项目与杭州深度求索人工智能基础技术研究有限公司无隶属关系。

本仓库采用**分层许可**（与上游一致）：

| 覆盖范围 | 许可 | 文件 |
| --- | --- | --- |
| 本插件原创代码（`src/` 除下列两处、`test/`、`tools/`、构建配置与文档） | MIT | [`LICENSE`](LICENSE) |
| 再分发的上游内容与由上游规范派生的部分 | CC BY-NC-SA 4.0 | [`LICENSE-CC-BY-NC-SA-4.0.md`](LICENSE-CC-BY-NC-SA-4.0.md) |

**整个仓库及其再分发内容均不得用于商业用途。**

---

## 1. DeepSeek Whale-chan Project（上游）

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
  同理，`test/character-prompt.test.ts` 的差分测试对照的是**本项目的移植来源 Python 实现**，
  不是上游脚本 —— 它防的是移植漂移，不是"与上游一致"。
- 上游的许可声明（逐字引自上游 `README.zh.md`）：
  - **开源代码与工具链**采用 MIT License（注：上游仓库根目录**没有** `LICENSE` 文件，该链接目前是死链）；
  - **规范文档与 Skills 模版**（角色规范白皮书、提示词模板、分镜规则、Skill 配置）采用 CC-BY-NC-SA 4.0；
  - 「任何商业性使用，商业出版或盈利性衍生品开发，必须获得相关原始著作权人及相关品牌权利方的明确书面授权。」
  - 引用或基于本项目规则生成的内容，建议注明出处为 `DeepSeek Whale-chan Project`。
- **授权状态（截至本提交）**：尚未收到上游的书面授权，也尚未向"公开"发布 —— 本仓库目前是**私有**的，
  并且正在向上游提交授权申请。在收到明确书面授权之前，这些内容的再分发依据是上游的 **CC-BY-NC-SA 4.0**
  条款（署名 + 相同方式共享 + 非商业），本节在收到授权后会补上授权链接与范围。

## 2. 角色形象与二创著作权归属（上游声明的第三方）

上游 `README.zh.md` 的「角色形象与二创著作权归属」一节声明：部分已知核心形象设定与二创素材来源于以下创作者，
**其原始著作权归原作者所有**：

- B站 **ZipZipPipe** — <https://space.bilibili.com/4168597>
- B站 **上善无形** — <https://space.bilibili.com/4456176>

鲸鱼娘形象的诞生、演进与传播基于广大网友的集体创作。本插件不包含上述创作者的原始作品，但再分发的参考图
源自包含其贡献的角色设定体系，因此这一归属声明必须随本仓库一同保留。上游同时要求关注「其他任何创作者的权利」。

## 3. 运行时依赖（本插件不包含其代码）

| 依赖 | 许可 | 与它的关系 |
| --- | --- | --- |
| [`@dickpy/dsh-imagegen`](https://github.com/dickpy/dsh-imagegen) | Apache-2.0 | 仅通过本机 loopback HTTP 调用其 `/api/dsh-imagegen/*` 路由。**不包含、不修改、也不再分发其任何代码**，因此不构成衍生作品。 |

本插件调用的图像渠道由用户自行配置，产生的费用由用户自付；插件在花钱之前会把将要发送的完整 prompt 与
模型/尺寸交给用户确认。

## 4. 再分发的文件清单（自动生成，请勿手改）

由 `node tools/verify-notices.mjs` 依据 `vendor/PROVENANCE.json` 与 `vendor/` 目录实际内容生成，
`node tools/verify-notices.mjs --check` 会断言它与仓库现状一致。

<!-- vendored-files:begin -->
再分发文件共 **16** 个，合计 **1464597** 字节。清单与摘要由 `tools/verify-notices.mjs` 生成。

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

整树摘要（`vendor/PROVENANCE.json` 记录的口径）：`8e9a018d50ab2220c0140048ce50f00f225a6e4b08bf1be7cbb0c722bc7e6ac4`

上游对应位置：`skills/whalechan-image-character/`（源头 `../dsh-whalechan/.dsh/skills/whalechan-image-character`）。
<!-- vendored-files:end -->
