# kel — 儿童英语视频库

给 3 岁孩子看的英语视频（儿歌、跳舞、动画）。粘一个 YouTube 链接（或从手机里选一个文件），
家里的 Mac 下载并统一转码，上传到 R2，之后在 iPhone 上打开网页就能播、能投屏到电视，
并且记得他看到哪、该复习什么。

四个包，各干一件事：

| 包 | 跑在哪 | 干什么 |
| --- | --- | --- |
| `apps/worker` | Cloudflare Workers | 登录、库、任务队列、去重判定、学习状态、上传中转、静态资源 |
| `apps/web` | iPhone Safari | 今天要看、列表、搜索、播放、添加、上传 |
| `apps/agent` | 家里的 Mac | yt-dlp 下载 → ffmpeg 转码 → 上传 R2 |
| `packages/shared` | 三边共用 | Zod 契约、链接解析、任务状态、学习规则、SHA-256 |

先读 [`CONTEXT.md`](./CONTEXT.md)（术语表），再读 [`docs/adr/`](./docs/adr)（四个不好回头的决定）。
这两份文件解释了下面每一步**为什么**长这样。

> 现在能用的：登录 → 加视频（粘链接 / 传文件）→ 下载归一化上传 → 列表与搜索 → iPhone 播放 →
> 记录看了几遍、学到哪、喜不喜欢 → 每天给一份「今天要看」。含去重硬拦、任务进度、自动重试。
> 还没有：字幕、Focus Words、AI。

---

## 从零到能用

按顺序来，每一步都依赖上一步。

### 1. 装依赖

```bash
pnpm install
brew install yt-dlp ffmpeg      # Agent 要用，Worker 不要
```

`yt-dlp` 会过期——YouTube 一改页面它就下不动。`brew upgrade yt-dlp` 是这个项目最常做的维护动作。

### 2. 建 Cloudflare 资源

```bash
cd apps/worker && npx wrangler login && cd -
./scripts/setup-cloudflare.sh
```

一条命令搞定：D1（`kel`，并自动把 `database_id` 回填进 `wrangler.jsonc`）、两个 R2 桶、关掉
`kel-media` 的 `r2.dev`、挂上 `media.felixli.io` 自定义域、传一个 `robots.txt`、生成
`SESSION_SECRET` 和 `AGENT_TOKEN`。可以反复跑：已存在的资源跳过，**已存在的 secret 不会被轮换**
（轮换 `AGENT_TOKEN` 会静默弄坏一个正常工作的 Agent）。

留下它打印的 `KEL_AGENT_TOKEN=...`，第 5 步要用——只在新建那一次显示。

> 两个桶不是洁癖。`kel-media` 是公开的（[ADR-0002](./docs/adr/0002-playables-are-served-from-a-public-bucket.md)：
> 投屏时是电视自己去取文件，不带 cookie），所以每晚的元数据导出必须放在另一个桶里，
> 否则整个库的清单就挂在公网上了。手机传上来的原片同样只落在私有桶，转码完就删
> （[ADR-0004](./docs/adr/0004-uploads-are-hashed-in-the-browser-and-relayed-through-the-worker.md)）。

### 3. 生成密码

```bash
pnpm gen-password --set     # 打印密码，hash 直接推给 Worker（hash 不落盘、不打印）
pnpm gen-password           # 只打印，自己去 wrangler secret put
```

密码只打印这一次，任何地方都只留 PBKDF2 hash——**当场存进 iPhone 的密码管理器**。
丢了不用慌，重跑 `--set` 覆盖即可。

**不要把它换成一个好记的密码。** 这不是建议。免费版 Workers 每个请求只有 10ms CPU，
PBKDF2 只能跑 1000 轮——安全性全部来自密码本身有 97 bit 熵。理由写在
[ADR-0003](./docs/adr/0003-the-password-is-generated-not-chosen.md) 里，换密码前请先读它。

### 4. 建表并部署

```bash
pnpm db:migrate:remote
pnpm release
```

> `pnpm deploy`、`pnpm doctor`、`pnpm start` 都是 pnpm 自己的内置命令，同名 script 永远跑不到。
> 所以这里叫 `release`，Agent 自检叫 `agent:check`。

打开 `https://app.felixli.io`，应该看到登录框。先登进去确认密码对，再往下走。

### 5. 配家里的 Mac

```bash
cp apps/agent/.env.example apps/agent/.env
# 填 KEL_AGENT_TOKEN（第 2 步）和四个 KEL_R2_*
```

R2 凭证在面板：R2 → Manage API Tokens → Object Read & Write，**只勾 `kel-media`**。
Agent 不需要、也不应该能读到私有桶——它要取手机传上来的原片时，是走 Worker 上一个校验租约的
接口拿的，不是自己去桶里翻。

自检，它会一路查到底——PATH 上的工具（含 libx264）、Worker 通不通、token 对不对、R2 凭据有没有效：

```bash
pnpm agent:check
# 多给一个链接，会额外用 --simulate 确认这条能选到 avc1+mp4a（不真下载）
pnpm agent:check '<在这里粘一条你真的想加的链接>'
```

选不到 `avc1+mp4a` 不是错误，只是意味着这条要重新编码：慢几分钟，但结果一样能播。

**先用 `agent:check` 验链接，再往库里加。** 有些视频从国内网络取不到（区域限制），yt-dlp 报的
是 `This video is not available`，紧接着可能再抛一个 `INNERTUBE_CONTEXT` 的 KeyError——那是
yt-dlp 回退到备用客户端时自己崩了，不是配置问题。这种链接换一个就好。

全绿了再让它常驻。两种方式，选一个：

```bash
./scripts/install-agent-service.sh          # launchd：开机自启、崩溃重启、日志落盘
pnpm agent:start                            # 前台跑，看得见日志，Ctrl-C 就停
```

launchd 是真正的「开机启动」；前台跑（比如放在一个 Herdr pane 里）适合调试期，
好处是日志直接在眼前，坏处是重启机器就没了。日志位置：`~/Library/Logs/kel-agent/agent.log`。

### 6. 第一个视频

在 iPhone 上打开 → 添加 → 粘链接。列表里那一条会从「排队中」走到「下载中 / 转码中 / 上传中」，
完成后出现缩略图。点开播放，第一帧应该几乎是立刻出来的。

如果它一直停在「已排队 · 家里的机器没开机」，那就是字面意思：Mac 睡了、或者没登录、或者服务没起。
这个状态是故意做成这样的，不转圈假装在干活。

---

## 每天怎么用

**「今天要看」是入口。** 列表页最上面那一条，右边的数字是今天还有几个该复习。点进去是一份短单子：
该复习的（最久没看的排前面）＋ 一两个没看过的新的，总共十来分钟——3 岁的注意力就这么长。
看完的会自己从上面挪到下面「今天看过了」，数字跟着减，所以那个数字始终是「还剩多少」。

**看够了才算一遍。** 看满 30 秒、或者视频长度的 40%（取小的那个）才记一遍；拖进度条不算。
算上一遍之后，下次复习按 当天 → +1 → +2 → +4 → +7 → +15 → +30 天往后排（[CONTEXT.md](./CONTEXT.md)
里的 Review）。第一档是「当天」不是笔误：这个年龄最有用的复习就是同一天再放一遍，所以它会留在
「今天看过了」里，他要就再放，不要就算了。

**自己先看一遍，要开预览模式。** 播放页下面的「我自己先看一眼（不计入）」。开着的时候顶上有一条
橙色的条——它是粘住的（关掉页面也还在），因为验二十个新视频的时候没人愿意点二十次开关；
但忘了关就等于白看，所以那条橙色故意很吵。

**「学到哪了」和「喜欢吗」只有你点才会变。** 机器只会做一件事：第一次看够了，把「没看过」改成
「看过了」。剩下的（熟悉 / 跟着唱 / 会用了 / 毕业）是你的判断，机器猜不出来。
点这些**不会**动复习日期——「他会用了」不等于「今天复习过了」。
标成「不肯看」的不再进「今天要看」，标成「毕业」的不再复习。

**从手机里传视频**：添加页下面「或者从手机里选一个」。选完文件先在手机上算一遍哈希（进度条第一段），
所以「库里已经有了」是在传之前就告诉你，不会白传十分钟。传完就可以关页面了——剩下的转码归一化
跟粘链接走的是同一条流水线（[ADR-0004](./docs/adr/0004-uploads-are-hashed-in-the-browser-and-relayed-through-the-worker.md)）。

---

## 平时怎么用

```bash
pnpm dev                    # Worker + web，本地一起起（Worker 在 :8787）
pnpm dev:agent              # 本地 Agent，配 .env 里 KEL_API_BASE_URL=http://127.0.0.1:8787
pnpm db:migrate:local
pnpm typecheck              # 四个包一起
pnpm check:sha256           # 手写的流式 SHA-256 与 node:crypto 对账（改了 sha256.ts 就跑）
pnpm check:learning         # 日期、复习阶梯、观看门槛（改了 learning.ts 就跑）
pnpm -F @kel/worker tail    # 看线上日志
```

那两个 `check:` 不是单元测试，是对账：它们各盯着一件「错了不会报错、只会静悄悄给出错答案」的事——
一个哈希算错就会放进重复视频或拦住新视频，一个日期算错就会让复习提前一天或永远不出现。

本地跑要有 `apps/worker/.dev.vars`（已 gitignore）。里面那个测试密码只在本地有效，
和线上是两套。

---

## 会踩的几个坑

**「库里已经有一模一样的内容了」** —— 去重生效了。同一个链接被 source key 拦在提交那一刻；
换了链接但字节一样（转载、镜像站）会被 source digest 拦在转码完成那一刻。传文件是最好的情况：
哈希在手机上先算，所以拦在传之前。三种都是硬拦，
不给「仍要添加」的选项（[CONTEXT.md](./CONTEXT.md) 里的 Duplicate）。想重新添加，先删掉旧的那条。

**删除是真的删。** 文件和记录都不留，没有撤销。每晚的导出能恢复标题和元数据，永远恢复不了视频本身。

**「第 N 次没成功 · 稍后自动重试」** —— 一次可能是临时故障的失败（网络抖动、YouTube 短暂 403）。
第一次失败等 1 分钟、第二次等 2 分钟再自动重来，不想等就点 重试，立刻再试一次。
明确不可能成功的（视频被删、私享、地区限制）不会重试，直接报失败。

**「多次尝试都没成功，家里的机器可能中途断了」** —— 任务试了 3 次都没做完。
通常是 Mac 中途睡了，或者 yt-dlp 该升级了。看 `~/Library/Logs/kel-agent/agent.err.log`。

**传文件失败了没有「重试」** —— 故意的。任务一死，那份原片就被删了（不然一堆没人看的原片会
一直占空间），所以唯一诚实的做法是重新选一次文件。上传中途关掉页面同理：页面会先问你一句，
真关了就得重传，那半份东西当晚会被清掉，Source Key 也随之释放。

**「上传的文件在传输中损坏了」** —— 手机算出来的哈希和 Mac 拿到原片后算出来的不一样。
这种不重试：字节和身份已经对不上了，重试只会得到同一个结果。重新传一次就好。

**数字一晚上不动** —— 先看播放页那条橙色的预览模式条是不是还开着。开着的时候看什么都不计入，
这是唯一一个会让整个 app 安静地失效的操作，所以那条特别显眼。

**换一台 Mac 跑 Agent** —— 复制仓库、`pnpm install`、拷 `.env`、`./scripts/install-agent-service.sh`。
代码里没有任何绝对路径，机器相关的东西全在 `.env` 里。两台机器同时跑也是安全的，
任务领取是原子的，不会重复下载同一个视频。
