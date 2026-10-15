# dsh-model-fallback

简体中文 | [English](README-en.md)

给 DeepSeek Harness 的每个主模型配一条**有序候选列表**：请求失败且错误类别命中你勾选的触发条件时，由链上的下一个模型接替这次请求——回合不中断，会话里注明改派原因。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg)](#构建)
[![build step](https://img.shields.io/badge/build%20step-none-lightgrey.svg)](#构建)
[![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-green.svg)](https://github.com/yn2aa/dsh-model-fallback)
[![status](https://img.shields.io/badge/status-beta-orange.svg)](#当前状态)

- **编排界面**：设置页 → 模型回退链。多条链集中在一个清单里管理，拖拽排序，按计费倍率或上下文窗口排序候选。
- **触发条件**：限流（TPM/RPM）、额度耗尽、HTTP 5xx、超时与网络错误，都是可勾选的开关。
- **安全默认**：没有链时插件完全不介入——不拦截、不改派、不产生任何标注。一个文件即可随时停用，无需重启。

安装见[安装](#安装)。想先看效果，[配置回退链](#配置回退链)有完整的界面说明。

## 为什么需要它

三条已在本机实测确认的事实：

1. **内核没有跨模型 fallback。** `@deepseek-ai/dsh-llm-retry` 只对**同一个 provider** 重试，`provider` 原样透传；它的 `Config` 甚至显式拒绝 `retryPolicy` 之外的键。
2. **本地网关也没有。** `127.0.0.1:8326` 的 `POST /v1/chat/completions` 经 `parseModelRoute` 切出唯一一个 `{provider, model}`，只调用一次 `llm.stream()`，没有别名表、模型组、也没有回跳。
3. **用户实际遇到的报错不在本机。** 逐字节扫描 121 MB 的 `app.asar` 与整个 profile `node_modules` 后确认：`litellm`、`model_group`、`No fallback model group`、`raccoon-4eb26a`、`node03-rg` **全部零命中**。那串报错由商汤上游服务端生成并透传；限流发生在服务端。

因此本机唯一能做的事是：**在本地这一跳失败时，改派到另一个模型。**

## 接管点与两条缝

插件挂在内核的两条 waterfall 上，而不是网关层：

```
会话请求 → Agent Loop
             ★ agent/request        —— 决定「下一次尝试用哪个模型」，必要时换成候选
           → ctx.llm.stream() → 渠道适配器 → 上游
             ★ agent/request-error  —— 唯一的失败观测点，决定「要不要重试」
           ↺ 重试回到同一 turn/step，再次经过 agent/request
```

- **为什么要两条缝**：`agent/request` 能换模型但看不到失败；`agent/request-error` 能看到失败但**载荷里没有 model**（只有 `provider`）。所以插件在 `agent/request` 上记下「实际发出去的是哪个模型」，失败时才归因得到是哪条链该动。
- **为什么不用 `agent/request-error` 的默认行为**：内核默认下游返回 `undefined`，循环就抛错结束回合；插件必须自己返回 `{kind:'retry'}`，重试才会发生——也才有下一次 `agent/request` 去改派。
- **会话请求走 `ctx.llm` 不经过 8326 网关**，所以只做网关层修不到会话里的报错。网关层（供其它用 base URL 调 8326 的工具）不在本插件范围内。

## 安装

> **桌面端限制（重要）**：桌面端启动前会扫描 profile 目录树，**只放行 dsh 自己在 `.dsh-module-fallback` 下生成的链接**。出现任何其它符号链接或目录 junction 会直接拒绝启动：
>
> ```
> PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
> ```
>
> 所以**不要用 `link:` 安装，也不要创建 junction**；用应用内插件管理器，或放置一个**真实目录**。

### 一键安装／卸载

```powershell
pwsh -File .\install\install.ps1     # 复制真实目录 + 登记依赖与 bundle
pwsh -File .\install\uninstall.ps1   # 上面那一步的完整逆操作
```

两个脚本默认按 `$DSH_HOME`（未设置则 `~/.dsh`）定位 profile，与插件自己的 `lib/store.js` 同一套规则。安装位置不同就传参：

```powershell
pwsh -File .\install\install.ps1 -ProfilePath '<你的 profile 路径>'
```

### 用 `dsh plugin` 命令行安装

`dsh` CLI 有一个 `plugin` 子命令，本质是把参数透传给 profile 里的 pnpm：

```powershell
dsh plugin --profile <profile-name> add dsh-model-fallback
```

**但它装不进桌面 profile。** `--profile desktop` 被硬拒：

```
error: profile "desktop" is managed exclusively by the Electron application
```

`desktop` profile 只归 Electron 应用自己管——它会重写 profile 的 `package.json`、自己维护 bundle 列表，CLI 插手会和它打架。所以这条命令**只对 headless 之类的自定义 profile 有意义**；桌面端请用上面的脚本或应用内插件管理器。

`dsh` 不是全局命令时，可以这样调（用 Electron 本体当 node 跑 CLI）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\DeepSeek Harness\DeepSeek Harness.exe' `
  'D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' --help
```

### 从零开始的完整流程

本包**没有构建步骤**（见下节），所以「构建→装载→看到分区」就是下面这四步。假设 profile 目录为 `<DSH_HOME>/profiles/desktop/`：

1. **放置真实目录。** 把本包整个复制到 `<DSH_HOME>/profiles/desktop/node_modules/dsh-model-fallback/`，必须带上 `lib/`、`cordis.patch.yml`、`package.json`（`README.md` 可选）。
2. **登记依赖。** 编辑 `<DSH_HOME>/profiles/desktop/package.json`，在 `dependencies` 中加入 `"dsh-model-fallback": "0.1.0"`（版本号跟随本包 `package.json` 的 `version`，**不要写成 `link:`**）。
3. **登记 bundle。** 在同一个 `package.json` 的 `dsh.profile.bundles` 数组末尾追加 `"dsh-model-fallback"`。
4. **重启 DSH。** 首次装载需要重启一次（替换已安装包的 JS 同样必须重启，见下表）。重启后打开 **设置 → 模型回退链**，应能看到该分区。

**不要再往 `cordis.patch.yml` 添加条目。** 被 `dsh.profile.bundles` 引用的包，其自带的 patch 层会自动生效；两处同时注册会报 `duplicate loader entry id`。

装好后启动日志里应出现自述行，用来把「装了但没生效」和「装了且在待命」区分开：

```
[model-fallback] loaded — data dir <DSH_HOME>/model-fallback, 0 chain(s)
[model-fallback] no chains configured — not intervening in any request
[model-fallback] runtime armed — settings API at /api/model-fallback
```

### 重启要求

| 改动 | 是否需要重启 |
| --- | --- |
| 装载／启用／禁用该插件（host 侧） | 否，实时生效 |
| **替换已安装包的 JS**（`lib/*.js`） | **是，必须重启** |
| 仅客户端 bundle（`lib/client.js`） | 否，但需 `pnpm run dev:web` 在跑才自动重建；否则刷新页面 |

替换已装载包的 JS 必须重启，是 ESM 模块缓存造成的：缓存以 URL 为键，文件改写不会让它失效，运行中的进程会继续执行内存里的旧代码。

客户端的实时改动依赖 `pnpm run dev:web` 重建 bundle；不跑该 watcher 时**刷新页面**即可看到改动。

## 配置回退链

打开 **设置 → 模型回退链**，页面自上而下是：**回退链管理区**（最顶部）、可用模型清单、候选编辑面板、冷却中的模型、最近改派记录。

后三块只在**按下某条链的「编辑」按钮后**才出现，并且只属于那一行链——没在编辑时，页面只剩管理区、冷却与历史，不占版面。

### 建一条链

1. **可用模型清单**是一张表格，排版与 DSH 自带的模型选择器一致：每个渠道一行**渠道标题**（如 `WorkBuddy (国际版)`、`LobsterAI (有道)`），下面是该渠道的模型行。表头给出每一列的含义：**模型名称**、**计费倍率**、**上下文窗口**、**来源**。
   - 单位**不写在页面上任何地方**，只在该行窗口数字的悬浮提示（`title`）里；所以表头只有列名、行里是光秃秃的数字 `1,000,000`。单位既不在表头里（`上下文窗口 tokens` 会比列里的数字还宽，把每个数字往前顶出一段空档），也不在每一行里（那就是重复噪音），也不必在表格上方单独写一句（读窗口列的人本来就知道是 tokens）。
   - 计费倍率、窗口与来源三列用**与模型名称同一套字体**（不再对数字单独用等宽字体），靠 `tabular-nums` 让数字仍然逐位对齐；短数字不会在列中间留下空档。免费模型显示绿色 `免费`（不再写 `x0.00`，那个零倍率本来就是「免费」的意思）。
   - **表头每一格都是同高的一行**（26px）：标签在左、排序按钮在右，没有第二行。表头曾经是「标签一行 + 单位一行」的两行结构，于是文字列与数字列的表头高度不同、标签基线也不同，固定表头的下边框在滚动时断成台阶；现在只有一行，两个问题一起消失。
   - 排序控件是一个**裸的 `↕` 字形**（没有边框和内边距）。带框的按钮会比列里的数字还宽，于是把每个数字前面顶出一段空档。
   - **表头在滚动时固定在上方**，并且是不透明的：翻页时不会有下层的行从表头里透出来。
   - **来源**列是最终写进 `chains.json` 的 `provider/model` 标识。
   - **排序有三档**：清单打开时「计费倍率」已按**升序**排好（`↑`，便宜的在前——看倍率就是为了挑便宜的），点一下变**降序**（`↓`），再点一下进入 `≡` **全局排序**：整个清单变成一条不分渠道的扁平列表，来源列只是信息、不再决定行的位置。第四次点击回到分组升序。「上下文窗口」列同理。价格或窗口查不到的模型在两个方向上都排在最后——翻转排序不会把「未知」顶到真实数字前面。
   - **每个渠道标题可以折叠**：点渠道标题行（左侧有 `▸`/`▾` 记号）即收纳或展开该渠道的模型，折叠只是视图、不写入任何配置；分组下有匹配行时才显示该组。
   - **清单本身可以整块折叠**：点「可用模型清单（N）」那一行（左侧有 `▸`/`▾` 记号）即收起整张表格，选完模型后不再占版面；标题行始终留着，就是展开的入口。折叠只是视图、不写入任何配置。当前编辑的那条链的主模型显示在同一行右侧的「当前主模型：」后面。
   - 清单与候选选择器的可视高度约 12 行（440px / 340px），超出滚动。
   - 搜索框匹配**模型名、渠道名和标识**（例如输入 `kimi` 或 `workbuddy` 都行），不只是标识。
   - 清单直接来自运行中的内核枚举，渠道新增或停用模型后清单会跟着变，不需要改插件代码；上下文窗口查不到时显示「未知」，不会编一个数字。
2. 在要当**主模型**的那一行左侧勾选**单选框**，再点搜索框右侧的「**设为回退链主模型**」，即新建一条链。清单顶部若还没有任何链，会显示「还没有配置任何回退链。插件不会干预任何请求，行为与安装前一致。」——**没有链时插件完全不介入**，这是安全默认值。
   - **同一个主模型可以有多条链**（例如两套候选配置轮换用）。同一时刻**只有一条能启用**：启用第二条时，第一条会被自动停用，并弹出一条可关闭的提示。停用不是删除，配置原样留着。
   - 新建的链会立刻进入编辑状态：管理区多出一行，名字按 `回退链1`、`回退链2`……自动递增，下面是可用模型清单与候选编辑面板。
   - 新建的链三类触发条件**默认全部勾选**（限流 / 服务端错误 / 超时与网络错误），尝试深度默认 3。新链如果默认全部关闭，你会以为插件坏了；勾选项就在链上，随时可以关掉不需要的类别。
3. 点该链上的「**添加候选（勾选即加入）**」，在展开的清单里**勾选**候选模型：勾一个就加入一个，取消勾选就移除——勾选状态本身就是链的内容，所以清单不会和链不一致；已经在链上的候选仍然列出来（否则就没有可取消的勾选框了），并且显示为已勾选。
   - 勾选时**页面不会跳**：新增的候选行渲染在这张清单的上方，会让清单整体下移；插件会在重排前记下清单的位置，渲染完成后把页面滚回原处，所以鼠标下的勾选框不会溜走。
   - 链建好后候选列表也可以收起：点链标题**左侧**的「候选模型（N）」（带 `▸`/`▾` 记号）即收纳该链的候选行，只留链标题——每条链各自独立折叠。折叠记号统一放在左侧，与「可用模型清单」的折叠记号对齐。
4. 用**拖动**（鼠标按住候选前的 `⠿` 图标）或 `↑`/`↓` 按钮调整候选顺序。拖动的作用域**只限本链**，不会影响其它链。顺序在拖放结束的瞬间写入；一次拖动只产生一次顺序写入。
5. 需要时调整该链的**触发条件**（可多选）。粗体是开关的名字，后面的灰字是说明：
   - **限流**——TPM/RPM 或额度用尽，上游返回限流错误、或账号全部在限流中时改派。典型是每分钟 token 用量超限。
   - **服务端错误**——HTTP 5xx，上游返回服务端错误时改派。适合应对服务端临时故障。
   - **超时与网络错误**——请求超时或连接中断时改派。
   取消勾选的类别**不会**触发改派，错误照常报给用户。
插件认的失败码是 `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `QUOTA_EXCEEDED` / `ACCOUNT_QUOTA`，外加「HTTP 状态 ≥ 500」这一兜底。`QUOTA_EXCEEDED` 按限流处理，是因为「账号全被限流」与「每分钟用量超限」同型——换个账号或模型就能救。反过来，`AUTH` / `INVALID_REQUEST` 这类错误改派也治不了，所以**故意不接**。
6. 设置**尝试深度**：一次失败最多尝试几个候选。用尽后不再重试，直接向用户报告**主模型的原始失败原因**（而不是最后一个候选的错误）。

### 管理已建好的回退链

设置页**最顶部**是一块「**回退链（N）**」清单，**每条链占一行**，这一块就是全部管理入口：名称（没起名字就显示主模型标识）、主模型标识、候选数量与尝试深度，右侧是操作。

- **编辑**——每行右侧的按钮，按下才展开属于这条链的「可用模型清单」与候选编辑面板（再按一次收起）。**同一时刻只有一条链在编辑**；按下另一行的编辑会替换掉当前面板。折叠与展开都只是视图状态，不写盘。
- **启用**——取消勾选后这条链**不参与改派**，但它对主模型的配置原样保留；勾回来即恢复。停用的行会变暗。停用一条链与「没有这条链」在运行时完全等价。
- **重命名**——**双击链名**把名称变成输入框，改完按回车或点开别处即保存（按 Esc 取消）。名称只是给人看的标签；链的身份是它自己的 `id`（没起名字就显示主模型标识），所以换名字不影响改派。留空则回落到主模型标识。
- **删除**——第一次点击变成「确认删除」，再点一次才真的删除。这是**两步确认**，因为删除没有撤销。

**没有链时**，管理区正中有一个「**添加链**」按钮：点它直接建一条空链（主模型待定，名字取下一个 `回退链N`），随后在可用模型清单里给它挑主模型。有链之后，这个按钮挪到管理区标题行右侧。

「可用模型清单」面板标题行右侧的「**当前主模型：**」显示的是**正在编辑的那条链**的主模型（名称、倍率与标识）；链还没挑主模型时显示「尚未选择」，没有链时不显示这一句。

新增链有两条路：管理区里的「**添加链**」（建一条空链再挑主模型），或在可用模型清单里单选 + 「设为回退链主模型」（直接用挑中的模型建链）。

要批量操作也可以直接编辑 `chains.json`。

链数据存在 `<DSH_HOME>/model-fallback/chains.json`。界面不保存自己的副本：每次读取都回到同一份文件，所以别的程序改了它，界面下次读到的就是新顺序。

### 候选不可用时会发生什么

渠道临时停用某个模型时，该候选会**留在链上**并标成橙色「不可用」加原因，**不会被静默删除**。渠道恢复后它自动回到正常呈现，位置和顺序都不变——不需要重新配置。

## 冷却与恢复

- 某个模型调用失败后，会进入**冷却**（默认 60 秒）。冷却期内它**不会被改派选中**，避免把请求反复送进同一个正在出问题的模型。
- 冷却**只影响「被改派选中」这一件事**，不会阻止你直接使用该模型：你手动选的模型永远照常调用。
- **冷却中的模型**分区会列出每个模型的标识、进入时间、预计恢复时间和原因，可以逐个「清除」，也可以「全部清除」。
- 冷却记录**只存在于内存中**，DSH 重启后清空。链配置在磁盘上，不受影响。

## 改派在会话里怎么显示

改派发生后，会话中会插入一条持久的 user 消息（走内核 `agent/pre-step` 的 `decision.messages` 通道，与内核自己的模型切换提示同一机制）：

```
[模型改派] 主模型 raccoon/sn-deepseek-v4-1-flash 因限流失败，本次回答改由候选模型 workbuddy/deepseek-v4.1-flash 生成。原始失败原因：rate limit reached for TPM
```

这条消息由插件写入，`source.kind` 是 `model-fallback`，因此可与内核自己的模型切换提示区分开。除了会话内的提示，**最近改派记录**分区也会保留最近的改派事实（原模型 → 实际模型、触发类别、结果）。

## 安全的关闭方式（kill switch）

创建 `<DSH_HOME>/model-fallback/disable`，内容写 `off`（`0`、`false` 同样有效），插件立即停止拦截——**每次调用都重新读这个文件，不需要重启**。删除该文件即恢复。

脚本形式（不用手建文件）：

```powershell
pwsh -File .\install\disable.ps1   # 立即停用，不用重启
pwsh -File .\install\enable.ps1    # 恢复
```

运行时的观测记录写在 `<DSH_HOME>/model-fallback/log.ndjson`（每行一条 JSON），用于排查「到底有没有触发」。该文件永不抛错，写不进去也不影响请求。

## 卸载

```powershell
pwsh -File .\install\uninstall.ps1
```

脚本会移除 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-model-fallback/`、`package.json` 的 `dependencies` 条目与 `dsh.profile.bundles` 条目，可重复运行。手工做的话就是这四步：

1. 删除 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-model-fallback/`
2. 从 `package.json` 的 `dependencies` 移除 `"dsh-model-fallback"`
3. 从 `dsh.profile.bundles` 移除 `"dsh-model-fallback"`
4. 重启 DSH

链数据与日志留在 `<DSH_HOME>/model-fallback/`，需要时手动删除。

## 构建

**本包没有构建步骤。** `lib/client.js` 是手写的 ModuleLoader bundle，只依赖 shell 已提供的 `react`；放好文件即被视为已构建。

若将来引入构建，注意 `@deepseek-ai/dsh-client-modules` 在缺少客户端 bundle 时会直接抛：

```
client-modules: client bundle not found; run `pnpm run build` before launch
```

## 开发

```powershell
npm test        # 全部单元测试（node --test，无外部依赖）
```

> `npm test` 必须走 npm：直接 `node --test test/` 在 Windows PowerShell 下 glob 不展开，会报 MODULE_NOT_FOUND。

测试不需要运行中的 harness：`lib/` 下的逻辑模块不 import 任何 `@deepseek-ai/*` 包，所有 harness 设施都通过 `ctx` 注入。客户端渲染冒烟测试自带一个最小 React 桩——因为 React 是 shell 提供的平台种子，不在磁盘上。

想在不启动 harness 的情况下确认「改动没有把会话打挂」，可以跑装载期预检（用 stub `ctx` 走完整改派周期，13 组断言；装载期抛错会让**所有工作区**一起崩，所以这一步值得跑）：

```powershell
node scratch/preflight.mjs
```

看不清界面时可以用预览器把它渲染出来，不必启动 harness：

```powershell
node scratch/preview.mjs scratch/preview.html      # 用真实样式渲染成静态 HTML
node scratch/preview.mjs scratch/preview.html --header-red   # 把固定表头涂红（看它是否遮住下面的行）
node scratch/preview.mjs scratch/preview.html --no-zindex    # 反证：去掉 zIndex 后是否仍然遮住
```

生成的 HTML 里有一段脚本会把清单滚动一段、把表头与数据行每个单元格的 `left..right` **和 `top..bottom`** 写进 `#measure`，并用 `elementFromPoint` 报告表头重叠处究竟是谁在上层——**列对齐、表头遮挡和表头等高都是量出来的，不是看出来的**。

Chrome 无头截图的 `--screenshot` 参数**必须是绝对路径**，相对路径会报「系统找不到指定的路径」。

## 已知边界

- **不做轮询。** 内核的 `agent/request-error` 载荷里没有 `model`，且每次重试都复用同一份已渲染的请求组装结果；插件只能在「下一次尝试」这个粒度上换模型，不能把一次失败重发到链上的其它候选。要真正的轮询，得自己变成一个 provider（在适配器的 `stream()` 内部走链）——那是另一个量级的工作，见归档 change 的 `implementation-notes.md` §36。
- **链只对自己声明的主模型生效。** 没有匹配链时按原样报错，不兜底。
- **网关层（127.0.0.1:8326）不在范围内。** 会话请求走 `ctx.llm`，不经过网关。

## 许可证

[MIT](LICENSE)。

## 目录结构

```
lib/index.js          插件入口（宿主半）：apply(ctx, config)
lib/failover-host.js  宿主接线：三条 seam 监听 + /api/model-fallback 路由 + 清单快照
lib/failover.js       改派核心：尝试序列、候选选择、重试判定（纯逻辑）
lib/chains.js         链数据模型：规范化、校验、失败分类、候选筛选（纯逻辑）
lib/cooldown.js       冷却账本（纯逻辑）
lib/notice.js         会话内改派提示的构造与排队（纯逻辑）
lib/catalog.js        从内核枚举模型清单与上下文窗口
lib/request-size.js   请求规模估算（chars/4，失败即未知）
lib/routes.js         /api/model-fallback 的纯请求处理
lib/store.js          数据目录、kill switch、NDJSON 日志、链读写
lib/probe.js          agent/request 契约探针（只记录、不接管）
lib/override-test.js  显式改派自检（默认惰性，需手动武装）
lib/client.js         浏览器半：设置页 UI
cordis.patch.yml      装载行（被 bundles 引用时自动生效）
install/              安装／卸载／禁用／启用脚本（PowerShell）
test/                 node:test 单元测试
scratch/              预览器、预检、内核源码提取器等开发工具（**不随包发布**）
```

## 当前状态

宿主侧改派逻辑、三条 seam 的接线、设置页 API 与设置页 UI 均已实现并有单元测试覆盖（`npm test` 全绿）。**真机端到端验收已完成**：限流（`RATE_LIMIT`）、服务端错误（`SERVER`）、额度耗尽（`QUOTA_EXCEEDED`）三类失败都实测触发过自动改派，会话未中断、模型切换提示已插入会话；「未命中触发条件不改派」「空配置等价」「上下文窗口过滤跳过候选」「清单来源变化」也都有实测证据（见归档 change 的 `acceptance-evidence.md`）。

**默认不介入**：链数为 0 时，请求路径与安装前完全一致——不拦截、不改派、不产生任何标注。
