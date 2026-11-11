# 交接说明（新会话先读这个）

更新时间：2026-11-11 晚。项目目录：`/Users/smy/workstation/myrta_manage_booking`，已是 git 仓库（分支 main）。

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
| 9 装配 | **部分**：入口、单实例锁、配置文件完成；**`npm start` 仍用占位 `UnavailableSession`，没接真实 `BrowserSession`**；Windows 打包、使用手册没做 |
| 10 第一次真实改约 | **等教练通知**，`BrowserSession.finish()` 故意没实现 |

191 个测试全部通过（`npm test`），类型检查通过（`npm run typecheck`）。

## 下一步（按顺序）

1. **接真实站点操作**：改 `src/main.ts`，`openSession` 用 `new BrowserSession({ profileDir, allowFinish: false })`。每个学员一个固定 profile 目录（`runtime/browser-profile/<学员id>`），保留 cookie；添加学员时的临时读取用 `probe` 目录。同时检查 `src/app/start.ts` 的 `fetchCurrent`：它在登录读取后会关闭会话，注意与刷新用的会话分开。
2. **会话复用要验证**：2 分钟间隔只有登录会话复用才可行（首次登录 70–95 秒）。`BrowserSession.login()` 已写了复用逻辑，但没有联网测过"保持多久"。
3. **Windows 打包**（计划任务 9）：`src/`、`data/`、生产依赖、Windows 版 `node.exe` 放进一个文件夹，加 `启动.bat`。`node.exe` 从 `https://cdn.npmmirror.com/binaries/node/v24.14.0/node-v24.14.0-win-x64.zip` 下载（约 8MB/s，比官方源快）。
4. **使用手册** `docs/user-guide.md`。
5. 以上做完后告诉教练，等教练通知再做任务 10。

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

- 完成页的样子、改约次数限制和费用、原考位是否释放、会话超时时长（都要等第一次真实改约）。
- 登录会话能保持多久。
- Akamai 对工具访问频率的容忍度，靠运行中观察和自动退避。
- 在真实 Windows 上的 Chrome/Edge 启动。

## 隐私约束

Booking number、姓氏、聊天内容不写进代码、测试、夹具、文档。测试用假数据（`1234567890` / `Testsurname`）。运行时数据在 `runtime/`，已忽略。教练聊天截图 `feature_issuejpg.jpg` 同样不入库。`/tmp/myrta_probe` 里还有早期探测脚本和聊天 OCR 文字，含对话内容，清理前先问用户。
