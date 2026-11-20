# 交接说明（新会话先读这个）

更新时间：2026-11-16。项目目录：`/Users/smy/workstation/myrta_manage_booking`，git 仓库。当前分支 `feat/electron-app`（基于 `feat/real-session`），都尚未合并到 main。

## 项目是什么

给驾校教练用的桌面独立应用（Electron，Windows 为主，也有 Mac 版）。教练为每个学员设定目标考点和时间段，工具持续刷新 myrta.com（NSW 驾考预约），出现完全符合的考位就自动改约，出现接近的考位就通知教练确认。

必读文档：
- `docs/requirements-architecture.md`：需求、规则、站点行为、架构图、风险
- `docs/plans/2026-11-11-implementation-plan.md`：实现计划、进度表、联网验证发现的站点行为、实测耗时

## 已确定的决定（不要再问教练）

- 近似匹配：时间偏差不超过 60 分钟、距离不超过 10 公里（直线距离），考点和时间同时有偏差也算接近，**接近的必须教练确认**。日期偏差默认 0 天，参数保留。
- 改约成功后，该学员任务结束；不满意由教练重新发起。
- 同时刷新的学员上限 2 个、间隔 2 分钟，放在隐藏配置里，界面不显示。
- 通知只做桌面通知。先做 Windows，架构保持跨平台。
- 技术选型（2026-11-16 改）：**Electron 38.7.2 独立应用**。主进程跑引擎、`node:sqlite` 数据库和本地界面服务，界面是 Electron 窗口。**学员刷新仍用本机 Chrome/Edge**：Electron 自带的 Chromium 访问 myrta.com 返回 403（改 UA 和 `sec-ch-ua` 也不行），见 `docs/specs/2026-11-16-electron-app-design.md`。Electron 二进制从 npmmirror 下载（`scripts/electron-bin.ts`），不走 electron 包自带的 GitHub 下载。
- 同时刷新上限 5 个学员（隐藏配置），每个学员最多 2 个考点。
- 试用授权：Ed25519 签名的 `license.json`，只限到期日期（悉尼时间当天结束），发现电脑时间调回就停。私钥在 `~/.myrta-license/private.pem`，**不入库**，丢了要换密钥对并改 `src/license/public-key.ts`，已发的授权全部失效。签发：`node scripts/license.ts --name 张教练 --until 2026-12-31`。
- 界面中英文可切换，默认中文。状态、记录、错误存成 `{k, a}` 消息（`src/ui/public/i18n.js`，界面和服务端共用），旧数据的中文句子原样显示。时间一律按悉尼时间显示。
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

## 2026-11-12 晚做了什么

- 现有预约（浅灰蓝）和目标（浅绿）分色，中间加箭头。
- 刷新间隔可调：全局（顶栏"⏱"按钮，写回 `runtime/settings.json` 的 `hidden.checkIntervalMs`）和学员单独（`students.interval_ms`，空表示跟随全局）。可选 1、2、3、5、10、15、30 分钟，最小 1 分钟，说明文字在 `src/config/interval.ts`。改了立即重新计时（`Scheduler.reschedule`）。
- 学员卡片显示已查轮数（`students.rounds`，重新开始清零，程序重启后自动继续不清零）、下一轮倒计时、本轮阶段（`Service.progress`）、还可刷新多久（`refreshDeadline`，引擎停止判断也用它）。
- 数据库加列由 `migrate()` 自动完成，旧数据库直接可用。
- 联网验证（Mac 包）：真实一轮约 2 分钟（新资料目录首次登录约 60 秒 + 两个考点），轮数和倒计时正确；Du 预约未变。

## 2026-11-16 做了什么（设计 `docs/specs/2026-11-16-electron-app-design.md`，计划 `docs/plans/2026-11-16-electron-app-plan.md`）

- 改为 Electron 独立应用：`src/electron/main.ts`。关窗口 = 退出（有学员在刷新/正在改约时先确认），单实例，数据在 `%APPDATA%\MyRTA Rebook` / `~/Library/Application Support/MyRTA Rebook`，Windows 首次运行建桌面和开始菜单快捷方式。去掉了 Chrome `--app` 界面窗口和 `启动.bat`/`启动.command`。`npm start` 仍可用（开发调试，打印界面地址）。`npm run app` 用 Electron 跑开发版。
- 打包 `node scripts/build.ts <win-x64|mac-arm64|mac-x64>`：Windows `MyRTA Rebook.exe`（resedit 改图标和版本信息），zip 约 136MB；Mac `MyRTA Rebook.app`（改 Info.plist，本机临时签名 `codesign -s -`），zip 约 111MB。应用代码在 `resources/app`，不打 asar。图标由 `scripts/icons.ts` 从 logo.svg 生成，结果在 `assets/`。
- iOA"下载完成"弹窗：不是下载，是 Chrome 往资料目录写 LOCK/LOG 等文件。添加学员时读取用的 `probe` 目录改名给该学员用，少建一个资料目录。彻底解决要把数据目录下 `browser-profile` 加白名单，写进了使用手册。
- 5 个学员：上限 5、每人最多 2 个考点、卡片显示"预计每 X 分钟刷新一次"（`expectedCycleMs`：设定间隔 + 一轮耗时，和"全部学员一轮总访问次数 × 20 秒"取大）。
- 试用授权、中英文界面，见上面"已确定的决定"。
- 测试 305 个，Node 24（`npm test`）和 Electron 内置 Node 22（`npm run test:electron`）都通过。
- Mac 包本地验证：带隔离标记解压 → 去标记 → 打开，界面窗口正常、授权提示正常、外部链接被拦、关闭后进程退出。

- 联网验证（Mac 包，出口 Sydney AU）：导入授权 → 添加 Du（78 秒）→ 刷新一轮（约 2 分钟）→ 退出，无残留浏览器 → 换一份新解压的程序、同一数据目录重新打开，Du 自动继续，轮数从 1 到 2，授权还在。全新会话核对 Du 预约未变。
- 联网发现并修复：(1) SIGTERM/关机时弹确认框卡住，学员 Chrome 留在后台，改为不经过窗口的退出直接收尾；(2) 暂停后马上退出，正在关的浏览器没等关完，改为 `stopAll` 等所有正在关闭的浏览器。
- 学员 Chrome 启动后自动最小化（CDP `Browser.setWindowBounds`）。实测最小化状态下登录、选考点、键入日期、读两周考位都正常，站点不拦。`MYRTA_MINIMIZE=0` 可关掉。

## 2026-11-16 确认页改为停住等教练

- 自动改约关闭时，完全符合或教练点"改到这个时间"后，走到确认页就停住：浏览器不关，窗口恢复到前面，保留 10 分钟（`HOLD_MS`）。期间只有这个学员不刷新。
- 教练可以直接在那个浏览器窗口里提交，然后点"我已在网站提交"；软件用 `login()` 重新读取预约核实（能后退就后退，停在完成页时重新登录）。预约变成所选考位就标记已改约；没变就继续刷新；读不到就暂停报警；变成别的考位就暂停请教练核对。
- "放弃，继续找"：回到查看预约页、窗口最小化、同一个浏览器继续刷新；这个考位本次运行内不再停下（`CheckState.skipped`）。超时自动放弃（不记入不再停下）。
- 暂停、删除、退出会取消保留并关浏览器；退出时提示"有学员停在确认页"。重启后状态是"已找到"，没有保留，界面显示旧的"打开 myrta.com / 继续找"。
- 2026-11-16 联网实测（AU）：停在 Silverwater 2026-11-20 12:00 确认页，窗口 normal；放弃用了约 20 秒，窗口 minimized，预约未变；下一轮跳过该考位，停在 2026-11-23 08:00。全新会话核对 Du 预约未变。
- "提交改约"按钮（软件代点 Finish）是第二步，要先在教练在场、同意的情况下真实提交一次，摸清完成页。

## 2026-11-17 原考位放出后立即查找

- 教练场景：学员 A 改到别的时间，学员 B 想要 A 原来的时间（都是正规报名，不是转让）。A 改约后原考位放回网站，B 立即去查。
- `Service.released(fromId, old)`：A 的预约变了（自动改约核实成功、"我已在网站提交"核实成功、保留期间预约变了、或登录时读到预约在软件外被改），对目标完全包含这个考位、正在刷新的其他学员 `runNow`，`RELEASE_RECHECK_MS`（1 分钟）后再补一次。原考位在 48 小时内不触发。仍受全局限速。
- `Service.checkNow(id)` + `POST /api/students/:id/check-now` + 卡片"立即查一次"按钮：A 不在软件里时教练手动触发。

## 2026-11-17 资料错误时不再卡住

- 原因：资料不对时站点留在登录页显示"The details you have entered are incorrect, please check the details and try again or call the Contact Centre on 13 22 13."，不跳转；旧代码等 URL 跳转 90 秒，旧正则也认不出这句。
- 现在 `waitForMain` 每秒看一次页面新出现的文字（`loginProblem`，和点 Continue 前对比），认出来立刻报 `bad_credentials`，带网站原话；在登录页 20 秒后有没见过的新文字也直接报出原话。实测点 Continue 后 2 秒报错。
- 添加学员：读取中可以点"取消"（关掉读取用的浏览器）；网站正在整体退避超过 2 分钟时直接提示稍后再加，不排队干等。

## 2026-11-17 退避期间仍在访问网站，拦截越拉越长

- 现象（教练截图）：放弃确认页约 6 分钟后被拦一次，之后 2 分钟、40 秒、1 分钟、2 分钟又被拦，退避 5→10→20→40→60 分钟。
- 原因：退避只挡住"查考点"前的限速排队，每一轮的开浏览器和登录不受限，退避期间照样访问网站，每次被拦又把退避翻倍。
- 修复：`Limiter.waitBackoff()`，每轮开浏览器、登录之前先等退避结束（界面阶段显示"暂停访问中"）；"改到这个时间"同样等。退避期间再报被拦不翻倍，退避结束后再被拦才翻倍。放弃确认页时如果正在退避，直接关浏览器不碰网站；放弃后下一轮按刷新间隔来（`Scheduler.start(id, delayFirst)`），不马上再访问。界面顶部显示"网站暂时拒绝访问，还要 X（HH:MM 恢复）"。
- 第一次被拦本身的原因还不确定（可能是确认页来回、访问密度）。退避修好后观察实际运行再判断。

## 2026-11-17 去掉附近考点；暂停立即停下

- 教练要求不查附近考点（界面上"查看 North Rocks"让人误解）。去掉了 `nearbyCentres`/轮换/`maxDistanceKm`，匹配只认目标考点（时间差 1 小时内仍算"接近"）。旧配置里的 `tolerance.maxDistanceKm` 忽略。启动时把以前附近考点留下的待确认考位标记为 dismissed。
- 暂停：以前只停调度，正在跑的这一轮要等跑完（浏览器还在查），教练手动关浏览器后记成"页面加载超时"。现在每次操作有自己的中断器（`Service.ops`），暂停时中断并立刻关浏览器，不记错误、不算轮数。
- 浏览器被手动关掉（Playwright "has been closed"）：记一条"浏览器窗口被关闭"，下一轮重新打开，不计入连续失败。`errorText` 只取报错第一行，去掉终端颜色码。

## 2026-11-19 会议结论落地：5 秒刷新、飞书推送、跳过首页、让位（软件替 A 改约）

- 刷新间隔改为毫秒档位（5/10/30 秒、1–30 分钟），默认 5 秒；全局最小访问间隔 20 秒 → 2 秒。教练接受被拦风险，被封 IP 时换路由器出口 IP。
- 飞书推送：`src/notify/feishu.ts`，只推 attention 级消息，只认 `https://open.feishu.cn/open-apis/bot/` 地址；界面顶栏"飞书通知"配置，存 `settings.json` 的 `notify.feishuWebhook`。地址不写死在代码里。
- Manage booking 深链接按首页地址缓存（`cachedManageHref`），后续会话直接跳转；失效回退首页。**未联网验证。**
- `BrowserSession.finish()` 已实现：选 `#existingPhone` → 勾 `#checkTerms` → 点 Finish（`#finishButton`，或文字为 Finish 的按钮）→ 识别完成页（"Finish in progress"/Step 5）成功；回到选时间页或"no longer available"为 failed；仍在确认页且有新提示则报错带原话。`readCurrent()` 在完成页回不到预约页时用最近一次登录资料重新登录。
- **Finish 按钮和完成页是猜的**，只在本地假网站（`test/helpers/mock-myrta.ts`）上验证。安全网：引擎提交后一律用 `readCurrent` 核实，读到新考位才算成功，否则暂停报警（`finish_unverified`）。
- 让位（`Service.setHandover`，`PUT /api/students/:id/handover`，库字段 `students.handover_to`）：一对一、不串联；B 的目标自动设为 A 当前考位且锁定；双方 `autoSubmit` 为真，即使全局自动改约关闭也点 Finish；`released()` 对 B 特殊处理（暂停了就启动）；B 改约成功后自动解除；删除 B 时清掉 A 的让位。
- 生产入口 `allowFinish: true`，但 `finishAvailable: false` 仍强制关闭全局自动改约——**只有让位双方会真正提交**。
- 测试：`npm test`（含 `test/handover.test.ts`，共享假网站的引擎测试）；`npm run test:e2e`（真实 Chrome + 假网站：BrowserSession 全流程、A→B 让位全流程，约 2.5 分钟）。
- **第一次真实提交**：教练在场、用不怕改的预约（48 小时以外）。核对确认页的电话选项/条款/Finish 按钮选择器和完成页文字，按实际修改 `flow.ts` 和 `mock-myrta.ts`。

## 2026-11-19 v0.2.1：按真实确认页修正提交；停在选时间页快速刷新

- 联网实测（只读，没点 Finish）：确认页电话单选框 `#rms_batCon-onFile`（默认选中）、条款 `#checkTerms`、Finish 是 Dojo 按钮 `#nextButton`（文字 Finish）。v0.2.0 猜的选择器不对，会在点 Finish 前停下。点 Finish 之前停下现在报 `not_submitted`（确定没提交），不再说成"可能已提交"。
- 实测耗时：查一周（从预约页走过去）17.6 秒、点页面翻周 6.5 秒、退回预约页 19 秒；网站每次响应其实只要 1–3.5 秒，慢在渲染（约 100 个脚本、150 张图、谷歌地图）。
- 选时间页 HTML 里有翻周地址（`window.location = '…action!nextWeek==/'`）。在页面里 `fetch` 它，站点就翻一周，返回完整的 `var timeslots`，约 2.7 秒，没被拦；请求页面地址等于刷新当前周。选考点、选位是带防机器人令牌（`a49gOr8Zpm…`）的表单，必须在页面里点，不能脱离浏览器。
- `BrowserSession` 停在选时间页（`parked`）：同一考点的 `listSlots` 在页面里直接请求，`login()` 10 分钟内直接返回上次读到的预约（`CURRENT_REFRESH_MS`）；`reachConfirm` 先让站点翻到那一周、重新载入页面再点格子。拿到的不是选时间页时按超时处理，下一轮重新登录。两个考点的学员每轮仍要切换考点（走完整流程）。
- 固定等待 1.5 秒改为 300 毫秒 + 等页面变过来（`expectKind` 最多等 15 秒）；登录点 Continue 时站点慢导致的点击超时不再报错。
- **新流程整轮耗时还没在真实网站上测到**：当天多次实测后网站登录卡住（疑似限流），隔一会儿的全新会话能登录。模拟网站上让位全流程 40 秒 → 14.5 秒。

## 2026-11-19 v0.2.2：自动改约默认开启，界面可切换

- `autoRebookEnabled` 默认 true（教练要求）。顶部"自动改约"标牌改为按钮，点一下确认后切换，写回 `settings.json` 顶层 `autoRebookEnabled`，重启保持（`PUT /api/settings/auto-rebook`）。`Service.setAutoRebook` 下一轮起生效。
- 生产入口 `finishAvailable: true`。`finishAvailable: false` 时界面不能打开（409），启动时按关闭运行并提示。
- 已有 `settings.json` 里明确写了 `autoRebookEnabled: false` 的保持关闭；没写的按新默认开启。

## 2026-11-19 v0.2.3：健壮性（自愈）

- 教练遇到"提交登录后没有进入预约页，也不是已知的错误提示"，要重启才好。现在不认识的登录失败按 `timeout` 处理：关浏览器、下一轮全新会话重试，连续 3 次才暂停（`reportError` 的 `failStreak`）。登录点击超时先等 8 秒看是否已跳转，没有才报 `err.login_click_timeout`。
- `tryReturnToMain` 看到被拦/验证码页面抛 `blocked`/`captcha`（走退避），不再当成"回预约页失败"暂停学员。
- 新错误类型 `slot_gone`：选位前考位被别人抢先约走是正常竞争，记一条日志继续刷新，不暂停（让位的 B 抢不到也不会挂起）。
- 页面内请求（`fetchWeek`）也过全局限速：`SiteSession.setThrottle`，`start.ts` 装配时挂 `limiter.acquire`。
- 拿到的不是选时间页时（`parked_lost`）同时清掉 `current`，下一轮强制重新登录。
- 端到端测试 13 个（`npm run test:e2e`，约 2.5 分钟）。工具有超时限制时放后台跑：`nohup npx vitest run -c vitest.e2e.config.ts > /tmp/e2e.log &`。

## 2026-11-20：教练在澳洲实测的三个问题

- **添加学员报"打开页面失败：Timeout 90000ms exceeded"**：`go()` 等 `domcontentloaded` 90 秒。很可能是页面正文早好了、只是某个脚本或图片（谷歌地图、遥测）一直卡着，整个事件没触发。现在超时后先看页面：正文有内容就当加载完成继续走（后面登录框、考位数据都有自己的等待），正文空才报错。
- **被拦退避整个去掉**（教练要求："理论上没啥作用，真封了 IP 重启路由器就行"）：`Limiter` 只剩 `acquire`/`waitLeft`；`reportBlocked`/`reportOk`/`waitBackoff`/`backoffUntil` 和界面退避横幅全部删除；`hidden.backoffBaseMs/backoffMaxMs` 配置不再读。被拦（`blocked`）和超时一样按临时失败处理：记 failStreak、关浏览器、下一轮全新会话照常开，连续 3 次才暂停。放弃确认页时不再判断退避。
- **暂停后点"继续"有时立刻又报错**：暂停时会立刻关浏览器，但旧 Chrome 退出要几秒；新会话在旧进程还没退出时用同一资料目录开 Chrome，新实例会把请求转交旧进程后自己退出，调试端口连不上报 `browser_no_response`。修复：`getSession` 等这个学员的浏览器关完（`pendingClose`）再开新的；`runCheck`/`doAccept` 收尾删中断器时只在还是自己的那个才删，避免旧操作把新操作的删掉。
- **打开页面空白超时再试一次**：上面那条超时如果正文是空白（页面真没回来），`go()` 自动重试一次才报错，偶发的空响应不用等下一轮。
- **让位 B 抢位提速（hot 模式）**：让位里接位的 B，每次停在选时间页的检查改成重新载入页面（`SiteSession.setHot`，`BrowserSession.hot`）而不是页面内请求。页面内请求后浏览器里显示的是旧的，抢位前要再载入一次整页（几秒到十几秒）；hot 之后页面一直是最新的，发现考位直接点格子。另外 A 点 Finish 看到成功页就立刻通知放出考位（`rebookSlot` 里 `finish()` 返回 success 就 `onReleased`），不再等十几秒的核实读取。抢位的发现路径没变（`released()` → `runNow`）。每轮检查变慢约一秒换抢位时省一次整页载入，只在让位期间生效。
- **登录点 Continue 报"点了登录但没有反应"**（旧消息 `err.login_click_timeout`）：点击只等 8 秒 + 再观察 8 秒，站点慢或 Dojo 控件没初始化时就报错。现在点击 10 秒超时后强制点一次（不检查可点击性）再补按回车，然后交给 `waitForMain` 看 90 秒页面变化；旧消息已删，卡片上残留的是老错误记录。
- **登录只从首页点进去**（教练要求，担心直接打开深链接被拦）：删掉 `cachedManageHref` 深链接缓存。每次登录都 `go(首页)` → 等 "Manage booking" 链接出现 → 真实点击（`noWaitAfter`，点不上就 `force`；`target=_blank` 改成本页打开）→ 等登录表单（按 `NAV_TIMEOUT` 90 秒）。表单没出来从首页再走一次，还不行报 `err.no_manage_link`（没链接）或 `err.no_login_form`（timeout 类，自动重试）。每次新会话登录多一次首页加载（站点慢时 8–40 秒）；会话复用、停在选时间页时不受影响。旧笔记"直接点会超时"是因为默认点击要等跳转完成，`noWaitAfter` 后不再有这个问题，**真实网站上还没验证点击**。
- **让位：A 提交前等 B 准备好**：两个浏览器加载速度不同，A 走到确认页时 B 可能还在登录。现在自动提交前调 `beforeFinish` → `Service.waitHandoverReady`：B 最近 `HANDOVER_READY_MS`（1 分钟）内查过 A 的考点、浏览器开着、没停在确认页才算准备好（`listed` 由 `onListed` 记录，`dropSession` 时清掉）；没准备好就记日志、启动或 `runNow` B，每秒看一次，最多等 `HANDOVER_WAIT_MS`（3 分钟），等不到不提交、停在确认页交给教练（`status.handover_wait_timeout`）。站点会话空闲 15 分钟才失效，3 分钟内 A 的确认页还有效。
- **添加学员对话框输入框点不中**：学员 Chrome 启动时用 `--start-minimized` 直接最小化（原来先弹出来抢前台焦点，过一两秒才最小化，期间主窗口的输入框点不中、打不了字）；对话框打开时主动聚焦第一个输入框。之前 CDP 连上后再最小化的兜底还在。
- **自动改约开关也管让位**：以前让位双方不管开关都自动提交（`autoSubmit`），现在去掉，双方和普通学员一样只看 `autoRebookEnabled`。关闭时 A、B 都停在确认页等教练（"我已在网站提交"后 A 的原考位放出，B 立刻去抢）。
- 端到端测试 13 个全过；改开关逻辑后单独重跑了 A→B 让位全流程（开关开启），通过。

## 下一步（按顺序）

1. **在真实 Windows 上走一遍**：解压 zip，双击 `MyRTA Rebook.exe`，看 SmartScreen 提示、快捷方式、中文显示（英文 Windows 也要看）、能找到 Chrome/Edge、添加学员能读到预约、关窗口后浏览器都关了、iOA 弹窗是否减少。
2. 把分支合并到 main（问用户）。
3. 以上做完后告诉教练，等教练通知再做任务 10（真实改约）。

## 本机环境要点

- 开发机 macOS，Node v24.14.0。npm 默认镜像（npmmirror）会卡住，`.npmrc` 已指向 `registry.npmjs.org`。装依赖要设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，再 `node scripts/electron-bin.ts` 取 Electron 二进制。
- Electron 窗口排查：`MYRTA_DEBUG_PORT=9333` 开放界面窗口的调试端口，可用 Playwright `connectOverCDP` 连上截图。
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
5. 首页 "Manage booking" 链接现在是真实点击（`noWaitAfter`，不等跳转完成），以前取 `href` 再 `goto` 是因为默认点击等跳转会超时。登录用 `#widget_input_bookingId`、`#widget_input_familyName`，逐字输入。
6. "Change location" 是 Dojo 按钮 `#changeLocationButton_label`，不是链接。
7. 期望日期 `#widget_rms_batDateSel` 必须键入，脚本赋值不生效且不报错；键入后读 `input[name=preferredDateStr]` 校验。键入后页面直接显示该日期所在的那一周。
8. 考位格子 id `rms_<星期>_<时分>` 的时间是 12 小时制、不补零、无冒号：15:00 → `300`，13:15 → `115`，08:00 → `800`。
9. 考位数据在内联脚本 `var timeslots = {...}`，一页一周。翻周用 `#nextWeekButton` / `#prevWeekButton`，选位后点 `#nextButton` 进确认页。

## 尚未验证

- 完成页的样子、改约次数限制和费用、原考位是否释放（都要等第一次真实改约）。
- Akamai 对工具访问频率的容忍度，靠运行中观察和自动退避。
- 在真实 Windows 上的 Chrome/Edge 启动。

## 隐私约束

Booking number、姓氏、聊天内容不写进代码、测试、夹具、文档。测试用假数据（`1234567890` / `Testsurname`）。运行时数据在系统应用数据目录（`npm start` 时是项目里的 `runtime/`，已忽略）。教练聊天截图 `feature_issuejpg.jpg` 同样不入库。`/tmp/myrta_probe` 里还有早期探测脚本和聊天 OCR 文字，含对话内容，清理前先问用户。
