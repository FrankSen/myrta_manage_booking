# 交接说明（新会话先读这个）

更新时间：2026-11-12。项目目录：`/Users/smy/workstation/myrta_manage_booking`，git 仓库。本次工作在分支 `feat/real-session`，尚未合并到 main。

## 项目是什么

给驾校教练用的 Windows 桌面工具。教练为每个学员设定目标考点和时间段，工具持续刷新 myrta.com（NSW 驾考预约），出现完全符合的考位就自动改约，出现接近的考位就通知教练确认。

必读文档：
- `docs/requirements-architecture.md`：需求、规则、站点行为、架构图、风险
- `docs/plans/2026-11-11-implementation-plan.md`：实现计划、进度表、联网验证发现的站点行为、实测耗时

## 已确定的决定（不要再问教练）

- 近似匹配：时间偏差不超过 60 分钟、距离不超过 10 公里（直线距离），考点和时间同时有偏差也算接近，**接近的必须教练确认**。日期偏差默认 0 天，参数保留。
- 改约成功后，该学员任务结束；不满意由教练重新发起。
- 同时刷新的学员上限 2 个、间隔 2 分钟，放在隐藏配置里，界面不显示。
- 通知只做桌面通知。先做 Windows，架构保持跨平台。
- 技术选型：Node 24 本地服务 + Chrome `--app` 窗口界面，**不用 Electron**（本机下载 Electron 二进制太慢）。数据库用 `node:sqlite`。
- 不能改到距现在不足 48 小时的考位；原考试不足 48 小时则预约锁定，停止该学员。

## 当前进度

| 任务 | 状态 |
|---|---|
| 1 脚手架与领域层（时间、距离、匹配器、配置、加密） | 完成 |
| 2 本地存储 | 完成 |
| 3 调度器与全局限速 | 完成 |
| 4 单个学员检查与改约逻辑 | 完成 |
| 5 页面解析 | 完成 |
| 6 浏览器接管与站点流程 | 完成，已用 Du 的预约联网验证到确认页 |
| 7 状态机与教练确认 | 完成 |
| 8 本地界面与通知 | 完成 |
| 9 装配 | **基本完成**：`npm start` 已接真实 `BrowserSession`（`allowFinish: false`）；Windows 打包脚本和使用手册完成。**没在真实 Windows 上跑过** |
| 10 第一次真实改约 | **等教练通知**，`BrowserSession.finish()` 故意没实现 |

203 个测试全部通过（`npm test`），类型检查通过（`npm run typecheck`）。

## 2026-11-12 做了什么

- `src/main.ts` 用 `new BrowserSession({ profileDir, allowFinish: false })`。每个学员的资料目录 `runtime/browser-profile/<id>`；添加学员的临时读取用 `probe` 目录，排队执行（同一目录不能开两个浏览器），每次读取前清空。
- `startApp` 新增 `finishAvailable`：为 false 时，即使 `settings.json` 开了 `autoRebookEnabled` 也强制关闭并提示。否则提交会报错并被记成"可能已提交"。
- 退出：先关浏览器让卡住的页面操作立即结束（最多再等 3 秒），退出中不再开新浏览器；处理 `SIGHUP`/`SIGBREAK`（Windows 关窗口）。`launchBrowser` 的 `close()` 会等进程真正退出。
- 选时间页既没有考位数据也没有"没有考位"提示时，不再当作 0 个考位（之前一次实测读到 0 个，可能就是这个原因），等 20 秒仍没有就报错。
- **会话复用已联网验证**：2 分钟一轮可一直复用；空闲 10 分钟仍可复用，空闲 15 分钟失效并自动重新登录。复用一轮约 35–65 秒。脚本 `scripts/session-reuse.ts`。
- 打包：`node scripts/build.ts` → `release/myrta-rebook/`（`启动.bat`、`node/node.exe`、`app/`、`使用手册.txt`）和 `release/myrta-rebook-0.1.0-win-x64.zip`（约 37MB）。node.exe 用 curl 下载，多个源依次尝试、续传，用官方 SHASUMS256 校验，缓存在 `release/cache/`。zip 用自己写的 `scripts/zip.ts`，给中文文件名设 UTF-8 标志（macOS 的 zip/ditto 都不设，Windows 会乱码）。
- 运行数据放在打包文件夹的 `runtime/`，在 `app/` 外面，升级时保留。
- 使用手册 `docs/user-guide.md`。

## 2026-11-12 下午做了什么（设计见 `docs/specs/2026-11-12-ui-time-mac-design.md`）

- 界面改为驾考风格；"需要你处理"区；"等你确认"改名"已找到（未提交）"，可一键用系统浏览器打开 myrta.com。
- 目标时间 15 分钟一档；新增指定时间（`Target.times`），接近按最近的指定时间算；最早时间联动最晚时间，反之不联动。
- 浏览器加 `QUIET_ARGS` 关闭后台下载（`MYRTA_QUIET=0` 可去掉，用于排查）。已联网冒烟通过，站点不拦截。
- `scripts/build.ts <win-x64|mac-arm64|mac-x64>`，输出 `release/<平台>/` 和 `release/myrta-rebook-<版本>-<平台>.zip`。Mac 包用 `启动.command`；zip 保留可执行权限。
- Mac 包完整联网验证：解压（带隔离标记）→ 启动 → 添加 Du（69 秒）→ 设置指定时间 → 刷新一轮出 5 个接近考位 → "改到这个时间"走到确认页（45 秒，未提交）→ 关窗口信号后程序、学员浏览器、界面窗口全部关闭。之后全新会话核对 Du 预约未变。
- 注意：VPN 断开时出口变成国内 IP，站点一律 403，不是参数问题。联网测试前先 `curl -s ipinfo.io/json` 看出口国家应为 AU。
- 为什么必须开浏览器窗口：无界面（headless）浏览器和 Playwright 直接启动的浏览器都会被 Akamai 拦。窗口可以最小化。

## 下一步（按顺序）

1. **在真实 Windows 上走一遍**（计划任务 9 步骤 4）：解压 zip，双击 `启动.bat`，看界面能打开、中文不乱码、能找到 Chrome/Edge、添加学员能读到预约、关掉黑窗口后浏览器都关了。macOS 上验证不了这些。重点怀疑：`chcp 65001` 下中文显示；Windows 上没有 `LANG`，浏览器语言只靠 `--lang`/`--accept-lang`，要看 `navigator.languages`；关窗口时 SIGHUP 的收尾时间是否够。
2. 把分支 `feat/real-session` 合并到 main（问用户）。
3. 以上做完后告诉教练，等教练通知再做任务 10。

## 本机环境要点

- 开发机 macOS，Node v24.14.0。npm 默认镜像（npmmirror）会卡住，`.npmrc` 已指向 `registry.npmjs.org`。
- `node src/xxx.ts` 可直接运行 TS；`tsconfig` 开了 `erasableSyntaxOnly`，不能用构造函数参数属性、enum 等。
- 脚本里别用 `timeout` 命令（本机没有）；联网脚本自己设硬超时。
- macOS 的 `sed -i` 要写 `sed -i ''`，复杂替换用 python。

## 联网测试规则（重要）

- 冒烟测试：`SMOKE_BOOKING_ID=… SMOKE_SURNAME=… node scripts/smoke.ts`，凭据**只通过环境变量**传入，不写进任何文件、脚本、测试或文档。
- 测试学员 Du 的 Booking number 和姓氏在项目根目录的 `rta_manage_tricket.jpg` 里（已加入 `.gitignore`，不入库）。图片读不出文字时用本机 Vision OCR，或让教练直接提供。
- **绝不点 Finish**，除非教练在场并同意。测试只能改到 48 小时以外。第一次真实改约要先告诉教练，由教练通知学员。
- 不要短时间内反复访问站点：每次联网测试之间留间隔，别连续重试。一次完整冒烟约 4–5 分钟。
- 测完检查预约没变：用全新会话重新登录，Du 当前预约应为 Silverwater Service NSW Centre，2026-12-30 11:30。
- 联网脚本结束后确认没有残留 Chrome 进程（`pgrep -fl remote-debugging-port`），并清理 `/tmp` 下的临时目录。

## 站点行为（踩过的坑，别改回去）

1. 浏览器必须**正常启动再用调试端口接管**（Playwright 直接启动会被 Akamai 拦成 403）。
2. 语言必须固定英文：`--lang=en-AU --accept-lang=en-AU,en`，环境变量 `LANG=en_AU.UTF-8`，启动后检查 `navigator.languages`。系统是中文时只传 `--lang` 不够，站点会返回无链接的中文页面，登录控件不初始化。
3. `curl` 访问站点永远 403，不能用来判断站点是否可达。
4. 站点很慢：首页 DOMContentLoaded 要 8–40 秒。超时 90 秒，只等 DOMContentLoaded，首页链接要轮询等待。
5. 首页 "Manage booking" 链接要取出 `href` 再 `goto`，直接点会超时。登录用 `#widget_input_bookingId`、`#widget_input_familyName`，逐字输入。
6. "Change location" 是 Dojo 按钮 `#changeLocationButton_label`，不是链接。
7. 期望日期 `#widget_rms_batDateSel` 必须键入，脚本赋值不生效且不报错；键入后读 `input[name=preferredDateStr]` 校验。键入后页面直接显示该日期所在的那一周。
8. 考位格子 id `rms_<星期>_<时分>` 的时间是 12 小时制、不补零、无冒号：15:00 → `300`，13:15 → `115`，08:00 → `800`。
9. 考位数据在内联脚本 `var timeslots = {...}`，一页一周。翻周用 `#nextWeekButton` / `#prevWeekButton`，选位后点 `#nextButton` 进确认页。

## 尚未验证

- 完成页的样子、改约次数限制和费用、原考位是否释放（都要等第一次真实改约）。
- Akamai 对工具访问频率的容忍度，靠运行中观察和自动退避。
- 在真实 Windows 上的 Chrome/Edge 启动。

## 隐私约束

Booking number、姓氏、聊天内容不写进代码、测试、夹具、文档。测试用假数据（`1234567890` / `Testsurname`）。运行时数据在 `runtime/`，已忽略。教练聊天截图 `feature_issuejpg.jpg` 同样不入库。`/tmp/myrta_probe` 里还有早期探测脚本和聊天 OCR 文字，含对话内容，清理前先问用户。
