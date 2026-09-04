# kel: 儿童英语视频库

给 3 岁孩子看的英语视频（儿歌、跳舞、动画）。粘贴 YouTube 链接或从手机选择文件，家里的 Mac 自动下载并转码，上传至 R2。在 iPhone 打开网页即可播放、投屏到电视，并记录学习进度与复习排期。

四个包各司其职：

| 包 | 运行环境 | 职责 |
| --- | --- | --- |
| `apps/worker` | Cloudflare Workers | 登录认证、视频库管理、任务队列、去重校验、学习进度、上传中转、静态托管 |
| `apps/web` | iPhone Safari | 今日片单、视频列表、搜索、播放器、添加与上传 |
| `apps/agent` | 家中 Mac | yt-dlp 下载（含字幕）、ffmpeg 转码、重点词统计、R2 上传 |
| `packages/shared` | 多端共用 | Zod 契约、链接解析、任务状态、学习规则、SHA-256、字幕解析、重点词算法 |

架构背景请参考 [`CONTEXT.md`](./CONTEXT.md)（术语表）与 [`docs/adr/`](./docs/adr)（五项架构决策）。

> 当前功能：登录、添加视频（链接或文件）、下载转码与上传、列表与歌词搜索、iPhone 播放（同步字幕高亮与重点词面板）、观看与偏好记录、每日「今天要看」推荐、硬去重与自动重试。
> 手机上传的视频不生成字幕（参见 [ADR-0005](./docs/adr/0005-transcripts-come-from-youtube-and-focus-words-are-counted.md)）。

---

## 快速上手

按顺序执行，每一步依赖上一步的配置。

### 1. 安装依赖

```bash
pnpm install
brew install yt-dlp ffmpeg      # 仅 Agent 需要，Worker 不需要
```

YouTube 页面结构调整可能导致 `yt-dlp` 下载失败，可定期执行 `brew upgrade yt-dlp` 更新。

### 2. 初始化 Cloudflare 资源

```bash
cd apps/worker && npx wrangler login && cd -
./scripts/setup-cloudflare.sh
```

该脚本会自动创建并配置：D1 数据库（`kel`，并将 `database_id` 写回 `wrangler.jsonc`）、两个 R2 存储桶、关闭 `kel-media` 的公共 `r2.dev` 访问、绑定 `media.felixli.io` 自定义域名、写入 `robots.txt`、生成 `SESSION_SECRET` 与 `AGENT_TOKEN`。支持幂等重复执行，已存在的密钥不会被覆盖（避免破坏正常运行中的 Agent）。

保存控制台输出的 `KEL_AGENT_TOKEN=...`，供第 5 步使用（仅在首次创建时打印）。

> 双桶设计说明：`kel-media` 设为公开读，满足电视投屏直接拉取媒体流的需求（[ADR-0002](./docs/adr/0002-playables-are-served-from-a-public-bucket.md)）。每日元数据备份与手机上传的临时原片均存入私有桶，转码完成后原片立即销毁（[ADR-0004](./docs/adr/0004-uploads-are-hashed-in-the-browser-and-relayed-through-the-worker.md)）。

### 3. 生成管理员密码

```bash
pnpm gen-password --set     # 打印密码，并将 hash 推送至 Worker（hash 不落盘）
pnpm gen-password           # 仅打印密码，需手动执行 wrangler secret put
```

密码仅在生成时显示一次，服务端仅保留 PBKDF2 hash。请立即将密码保存至 iPhone 密码管理器。如遗失可重新运行 `--set` 覆盖。

免费版 Cloudflare Workers 单次请求限制 10ms CPU 时间，PBKDF2 固定为 1000 轮计算，系统安全性依赖密码本身的 97 位熵，请勿修改为弱密码（详情参考 [ADR-0003](./docs/adr/0003-the-password-is-generated-not-chosen.md)）。

### 4. 数据表迁移与部署

```bash
pnpm db:migrate:remote
pnpm release
```

部署完成后访问 `https://app.felixli.io` 验证登录。

### 5. 配置 Mac Agent

```bash
cp apps/agent/.env.example apps/agent/.env
# 填写第 2 步的 KEL_AGENT_TOKEN 与四个 KEL_R2_* 变量
```

在 Cloudflare 控制台申请 R2 API Token（权限选择 Object Read & Write，仅授权 `kel-media` 桶）。Agent 仅能访问公开媒体桶，如需获取手机上传的原片，需通过 Worker 的鉴权接口拉取。

运行环境自检（检查 PATH 依赖、libx264、Worker 连通性、token 有效性及 R2 权限）：

```bash
pnpm agent:check
# 可传入测试链接模拟格式嗅探（不触发实际下载）
pnpm agent:check '<YouTube 视频链接>'
```

部分视频受地区版权限制可能返回 `This video is not available`，遇到此类链接更换其他视频即可。

自检通过后启动服务：

```bash
./scripts/install-agent-service.sh          # launchd 常驻：开机自启、故障重启、日志落盘
pnpm agent:start                            # 前台运行，适合调试（日志直接输出到控制台）
```

系统日志路径：`~/Library/Logs/kel-agent/agent.log`。

### 6. 添加第一个视频

在 iPhone 打开网站，点击「添加」，粘贴 YouTube 链接。任务将依次经历「排队中、下载中、转码中、上传中」，完成后生成预览封面。点击即可直接播放。

若任务停留在「已排队 · 家里的机器没开机」，请确认 Mac 处于唤醒状态且 Agent 服务正在运行。

---

## 核心使用机制

**「今天要看」片单：** 首页顶部展示待复习任务数。片单包含按间隔排期的复习视频（最久未看优先）以及 1 到 2 个根据已掌握词汇匹配的新视频，总时长控制在 10 到 15 分钟以内。看完的视频自动移至「今天看过了」，待办计数相应减少。

**有效观看与复习阶梯：** 连续观看满 30 秒或视频总时长的 40%（取较小值）计为一次有效观看，拖动进度条不计入。达标后触发复习阶梯排期：当天、+1天、+2天、+4天、+7天、+15天、+30天。当天重复观看仍保留在「今天看过了」列表中供再次播放。

**字幕同步与重点词面板：** 播放器下方实时高亮当前句，支持点击字幕任意行直接跳转重放。手指滑动字幕列表时自动暂停跟随滚动，再次点击字幕恢复定位。重点词区域按词频统计展示核心教学单词与句型（[ADR-0005](./docs/adr/0005-transcripts-come-from-youtube-and-focus-words-are-counted.md)）。

**歌词全局搜索：** 列表搜索框默认检索标题、频道与重点词。本地未命中时自动发起服务端全文检索，并在「字幕里也提到了」区域返回匹配片段。

**新片推荐策略：** 新视频优先推荐重点词与孩子「已熟悉」词库重合度较高的内容，降低冷启动难度。

**预览模式：** 点击「我自己先看一眼（不计入）」开启预览模式，顶部显示常驻警示条，播放行为不会累加观看次数与推进排期。

**进度与喜好标注：** 阶段状态（熟悉、跟着唱、会用了、毕业）由家长手动标注，修改状态不会改变复习排期。标为「不肯看」的视频将被移出每日片单，标为「毕业」的视频不再安排复习。

**手机本地上传：** 添加页支持直接上传手机视频。文件在前端先完成 SHA-256 计算，若库中已存在则在上传前直接拦截，避免无效流量消耗（[ADR-0004](./docs/adr/0004-uploads-are-hashed-in-the-browser-and-relayed-through-the-worker.md)）。

---

## 开发与对账命令

```bash
pnpm dev                    # 本地启动 Worker + Web（Worker 端口 :8787）
pnpm dev:agent              # 本地 Agent（需配置 KEL_API_BASE_URL=http://127.0.0.1:8787）
pnpm db:migrate:local       # 本地 D1 迁移
pnpm typecheck              # 全工程类型检查
pnpm check:sha256           # 流式 SHA-256 与 node:crypto 对账测试
pnpm check:learning         # 复习排期与观看门槛算法对账
pnpm check:focus            # 字幕解析与重点词统计算法对账
pnpm -F @kel/worker tail    # 查看线上 Worker 实时日志
```

三项 `check:` 脚本用于核心算法对账校验，防止哈希不一致、排期计算偏移或 Agent 重点词统计逻辑脱节。

本地开发需在 `apps/worker/.dev.vars` 中配置本地测试密码。

---

## 常见问题与边界处理

**重复视频拦截：** 链接完全一致时在提交时被 source key 拦截；不同链接但原片内容相同时在转码后被 source digest 拦截；手机上传在客户端计算哈希后直接拦截。重复项均直接拒绝添加。

**删除机制：** 删除操作会物理清除 R2 媒体文件、数据库记录与字幕信息，该操作不可逆。每日备份仅记录元数据，不保留媒体实体。

**任务重试策略：** 遇到网络抖动等偶发错误，系统会在 1 分钟、2 分钟后自动重试，最多 3 次。已删除或私密视频等明确不可恢复的错误将直接判定为失败。

**文件上传失败恢复：** 手机上传中断或任务异常时，临时存储的原片会被清理以节省空间，需重新选择文件上传。

**字幕缺失说明：** 手机上传视频不提供字幕与重点词提取（[ADR-0005](./docs/adr/0005-transcripts-come-from-youtube-and-focus-words-are-counted.md)）。YouTube 视频若原作者未提供字幕且未生成自动字幕，同样不会显示字幕面板，但不影响正常播放。

**自动字幕分句特性：** YouTube 滚动式自动字幕在解析时会自动剔除重叠前缀。官方作者字幕不存在此现象，字幕右上角会标注「官方字幕」或「自动识别」。

**停用词过滤：** 重点词统计词表位于 `packages/shared/src/focus.ts`。常用疑问词（what、where、how 等）保留在统计范围内，修改停用词配置后请运行 `pnpm check:focus` 验证。

**更换 Agent 宿主机：** 在新设备拉取代码并安装依赖，拷贝 `.env` 文件后运行 `./scripts/install-agent-service.sh` 即可。任务分发基于原子租约，支持平滑迁移。
