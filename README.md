# dsh-whalechan

DeepSeek Harness 插件：**说一句场景，画一张鲸鱼娘**。

一个工具，两次调用。它在**花钱之前**把将要发送的 prompt 全文、模型、能交付的尺寸和一个
`plan_id` 摆给你看；你点头之后才出图。图落地的一瞬间，插件自己把它交到你手上。**插件不对成品做
任何自动判定** —— 好不好看是你说了算。

> **非官方项目，且不得商用。** 社区作品，不是 DeepSeek 官方产物。本仓库分层许可：原创代码 MIT；
> 由上游规范派生的 prompt 编译器与上游目录元数据 CC BY-NC-SA 4.0；再分发的 15 张参考图**不在
> 上游任何 blanket 授权之内**。完整声明与逐文件 sha256 见
> [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

## 安装

1. 先装 **dsh-imagegen** 插件，在「设置 → 生图配置」里配好渠道和 API Key。本插件只是调用方，
   不碰你的密钥。
2. 侧边栏打开**「插件」**页，在安装框里填 `github:VioletZJM/dsh-whalechan`，装。
3. **重启 DSH。** 插件模块按真实路径缓存，只换磁盘上的文件不会重新加载。

命令行等价（`dsh` 不在 PATH 上时，桌面端自带的那份在
`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）：

```bash
dsh plugin --profile desktop add github:VioletZJM/dsh-whalechan
```

`web` / `tui` 等 profile 把 `desktop` 换掉即可。仓库里带着构建好的 `lib/`，**不需要
clone，也不需要任何构建步骤**。

## 用法

直接跟 agent 说人话，比如「画一张鲸鱼娘坐在地上吃白米饭，笑眯眯的」。背后发生的是：

```
① whalechan_image({ prompt: "坐在地上吃一碗白米饭，笑眯眯的", form: "3头身" })
     → 免费。返回将要逐字发送的 prompt 全文、模型、能交付的尺寸，以及一个 plan_id
② 你看过 prompt 和报价，同意
③ whalechan_image({ …, confirm: true, plan_id: "…" })
     → 出图，并立刻作为本轮交付物送到你眼前
```

角色身份、画风、服装、构图由插件内部编译，**你只描述场景**。

| 参数 | 说明 |
| --- | --- |
| `prompt` | 场景，用你自己的话。它**逐字**成为提示词的场景行 |
| `form` | 形式名（`standard` / `compact` / `semi-chibi` / `chibi` / `super-deformed`）或头身数如 `3`；默认 `semi-chibi` |
| `ratio` | 比例，如 `1:1`（默认）、`4:7`；干跑会列出该渠道能精确交付的全部比例 |
| `count` | 画几张。**每张都是一次计费的生成** |
| `model` | dsh-imagegen 里的模型别名；省略则走它的默认 |
| `plan_id` | 干跑返回的那个，`confirm: true` 时必须带上 |
| `confirm` | `true` 才真的花钱 |

第二次调用与第一次不一致（改了 prompt、模型或尺寸）会在**发送之前**被拒绝，一分钱不花。

## 配置

本插件没有客户端界面，四项配置写在 profile 的 `cordis.patch.yml` 里 —— **按 id 覆盖**已插入的
那一行（不要再写一个 `insert`，那会插出第二行）：

```yaml
- id: whalechan
  config:
    defaultModel: qwen-image-3.0
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就不再注册这个工具 |
| `imagegenBaseUrl` | 空 | dsh-imagegen 的地址，如 `http://127.0.0.1:19387`；留空自动发现 |
| `defaultModel` | 空 | 调用没指定模型时用它；留空走 imagegen 的默认 |
| `dataRoot` | 空 | 图片写到哪；留空用下面的默认路径 |

## 图片在哪

默认写到 `~/.dsh/dsh-whalechan/images/`（Windows 是 `%USERPROFILE%\.dsh\dsh-whalechan\images\`）。
每张图旁边有一个同名 `.json`，记着它的完整 prompt、模型、形式、比例、尺寸和 sha256。

正常情况下你不用去那个目录 —— 图会自己出现在对话里。只有交付失败时路径才会出现在结果里
（`delivery_error`）：那时图已经花钱画好了，找不到它才是真的失败。

## 出问题了

- **装完没反应** —— 先确认重启过 DSH。然后看 `~/.dsh/dsh-whalechan/state/loaded.json`：插件每次
  挂载都会写它，里面的 `version` 是宿主**真正加载**的那份。也可以读只读状态路由
  `GET /api/dsh-whalechan/status`。
- **图没自己送到眼前** —— 上面那个回执里 `delivery: false` 就是原因（宿主没接上会话投影）。
  插件仍然能出图，只是结果里会打印文件路径，由你自己去拿。
- **提示词过长** —— 编译器上限是 **800 字符**（不是渠道的 4000），超了会在**花钱之前**拒绝。
- **角色不像** —— 本插件走**参考图编辑**模式，每次请求都带上身份锚图，渠道必须支持参考图。
  这是角色一致性的唯一来源。

## 许可

本插件原创代码 MIT；由上游规范派生的 prompt 编译器与上游目录元数据 CC BY-NC-SA 4.0；`vendor/` 里
那 15 张参考图**不在上游 blanket 授权内**，本仓库以非商业方式再分发（逐字节未改、署名保留，
权利人要求即撤下）。**整个仓库及其再分发内容均不得用于商业用途。**

来源、上游比对基准、授权记录与逐文件 sha256 见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；
许可正文见 [`LICENSE`](LICENSE) 与 [`LICENSE-CC-BY-NC-SA-4.0.md`](LICENSE-CC-BY-NC-SA-4.0.md)。
