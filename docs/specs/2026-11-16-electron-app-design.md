# 设计：改为独立应用（Electron）、5 个学员同时刷新、试用到期、中英文界面

日期：2026-11-16，用户已确认。实现时在 `feat/real-session` 之上新建分支 `feat/electron-app`。

## 背景

现在的运行方式：`启动.bat` / `启动.command` 开一个命令行窗口跑 Node 服务，界面用本机 Chrome 的 `--app` 窗口。问题：
- 界面是浏览器窗口，依赖本机 Chrome/Edge；
- 有命令行窗口，关掉它程序就退出；
- 不像正常软件（没有图标、没有快捷方式、Mac 上不是 `.app`）；
- 在装了腾讯 iOA 的电脑上频繁弹出"下载完成"。原因是 Chrome 往资料目录（如 `runtime\browser-profile\1\Default\BudgetDatabase\LOCK`、`LOG`）写本地数据库文件，iOA 把 Chrome 新写的文件当成下载。这些不是网络下载，`QUIET_ARGS` 管不到。

## 实验结论（2026-11-16，出口 Sydney AU）

- Electron 38.7.2 自带的 Chromium 打开 myrta.com 首页：**403**。把 User-Agent 和 `sec-ch-ua` 改成真实 Chrome 的样子后仍是 403。
- 同一网络、间隔 2 分钟，本机 Chrome 按现有方式启动：**200**。
- 结论：**学员刷新必须继续用本机 Chrome/Edge**，Electron 只做界面和主程序。iOA 弹窗不能靠换 Electron 解决（见第 2 节）。
- Electron 38 内置 Node 22.21.1，`node:sqlite` 可用，可直接运行 `.ts`（类型擦除）。项目 `engines` 写的是 Node ≥ 24，需在 Electron 的 Node 里跑通全部测试才算兼容。

## 1. 进程与窗口

- 一个 Electron 应用。主进程直接运行现有的引擎、数据库、本地 HTTP 服务（`startApp`），不再附带 `node.exe`。
- 界面：Electron `BrowserWindow` 加载本地服务的页面（`http://127.0.0.1:<port>/?token=…`），前端代码基本不变。窗口只允许打开本地服务地址，其他链接交给系统浏览器（`shell.openExternal`）；开启 `contextIsolation`、`sandbox`，不开 `nodeIntegration`。
- 学员刷新：继续用本机 Chrome/Edge，启动和接管方式（`launchBrowser`）完全不变。找不到 Chrome/Edge 时弹窗提示安装。
- 只允许一个实例（`app.requestSingleInstanceLock()`，再次打开时把已有窗口拉到前面），保留现有文件锁。
- 关窗口 = 退出：有学员正在刷新时先弹窗确认；有学员停在确认页时额外提示。退出时执行现有的 `app.stop()`，关闭所有学员的 Chrome。
- 桌面通知改用 Electron `Notification`。
- 去掉 `defaultOpenWindow`（Chrome `--app` 界面窗口）和 `src/main.ts` 里对 SIGHUP/SIGBREAK 的处理（不再有命令行窗口）。保留纯 Node 启动方式（`npm start`）用于开发调试，界面地址打印到控制台。
- 数据目录：Electron `app.getPath('userData')`，即 Windows `%APPDATA%\MyRTA Rebook`、Mac `~/Library/Application Support/MyRTA Rebook`。里面就是现在 `runtime/` 的内容（数据库、密钥、`settings.json`、`browser-profile/`），另加 `license.json`。`MYRTA_RUNTIME_DIR` 仍可覆盖。
- 注意：Electron 自己的缓存也写在 `userData` 下，界面窗口的会话放到子目录 `ui-session/`，不和业务数据混在一起。

## 2. 5 个学员同时刷新

- `hidden.maxActiveStudents`：2 → **5**，仍在隐藏配置里。
- 每个学员最多选 **2 个考点**（`parseTarget` 校验，界面勾选第 3 个时提示）。每轮另外轮换 1 个 10 公里内的附近考点（现有逻辑不变），所以每个学员每轮最多 3 次访问。
- 全局访问间隔 `globalMinGapMs` 保持 20 秒。5 个学员 × 3 次 × 20 秒 ≈ 5 分钟一圈，实际每个学员 3–5 分钟刷新一次。
- 界面显示"预计每 X 分钟刷新一次"：`max(设定间隔, 正在刷新的学员总访问次数 × 全局间隔)`，放在学员卡片和顶栏刷新设置旁边。估算函数放在 `src/config/interval.ts`，纯函数可测。
- 学员 Chrome 最小化：联网实测"启动后最小化"站点是否拦截。不拦就默认最小化（通过 CDP `Browser.setWindowBounds` 设为 `minimized`，不改启动参数）；拦就保持现状并在文档记录。
- 减少 iOA 弹窗：添加学员不再每次清空 `probe` 目录；添加成功后把 `probe` 目录改名为该学员的资料目录（`browser-profile/<id>`），第一轮刷新直接复用登录状态。读取失败才清空 `probe`。
- iOA 白名单说明写进使用手册：把数据目录下的 `browser-profile` 或 `chrome.exe` 加入白名单（需电脑管理员操作）。

## 3. 试用到期

- 授权文件 `license.json`：
  ```json
  { "name": "张教练", "until": "2026-12-31", "issuedAt": "2026-11-16", "sig": "<base64>" }
  ```
  `sig` 是对 `name|until|issuedAt` 的 Ed25519 签名。软件里只放公钥（`src/license/public-key.ts`）；私钥只在开发者本机，路径由 `MYRTA_LICENSE_KEY` 指定，**不入库**。
- 生成：`node scripts/license.ts --name 张教练 --until 2026-12-31 --out license.json`。第一次使用时 `node scripts/license.ts --init-key` 生成密钥对并打印公钥。
- 导入：没有有效授权时界面只显示导入页，教练选择文件导入（Electron 文件对话框），复制到数据目录。
- 到期：按悉尼时间 `until` 当天 23:59:59 结束。
- 防调回系统时间：数据库记录见过的最晚时间（每轮检查和每次启动更新）。当前时间比它早 1 小时以上视为时间被调回。
- 无授权 / 过期 / 时间被调回：停止所有刷新、不允许开始和添加学员，已有学员和记录仍可查看；顶部提示"试用已到期，请联系开发者续期"。
- 检查点：启动时、每轮检查开始前、开始刷新和添加学员的接口。
- 局限（已告知用户）：离线授权防一般用户，防不住解包修改代码的人。

## 4. 中英文界面

- 顶栏切换"中文 / English"，默认中文，选择保存在 `settings.json` 的 `ui.language`。
- 翻译表 `src/i18n/zh.ts`、`src/i18n/en.ts`，键相同，测试检查两边键一致、占位符一致。前端拿到当前语言的整张表。
- 范围：界面文字、按钮、提示、服务器返回的错误、桌面通知、学员状态说明、运行记录。
- 状态说明改为存"代码 + 参数"：`students.status_code`、`students.status_args`（JSON），显示时翻译。旧数据只有 `status_note`（中文句子），没有代码时原样显示。运行记录同理。
- 时间显示：全部按悉尼时间（`Australia/Sydney`），修正 `app.js` 里 `fmtStamp` 用电脑本地时区的问题。
- 使用手册中英文各一份。
- 中文显示：Windows 10/11（任何系统语言）自带微软雅黑/宋体，macOS 自带苹方，CSS 字体列表写明这些字体，不需要另装。

## 5. 升级不影响正在刷新的学员

- 学员资料、目标、状态、轮数、授权都在数据目录，和程序分开；升级只替换程序。
- 启动时 `resumeAll` 恢复所有"刷新中"的学员，轮数不清零（现有行为）。
- 数据库只增列，不删不改名，由 `migrate()` 自动完成。新增测试：用旧版本结构的数据库启动新版本，数据完整、能继续刷新。
- 升级步骤（写进手册）：关闭软件 → 替换程序 → 重新打开，自动继续。
- 不做自动更新，不做旧版本数据导入（教练没用过旧版本）。

## 6. 打包

- 不用 electron-builder（要另外下载很多东西，本机网络慢）。改写 `scripts/build.ts <win-x64|mac-arm64|mac-x64>`：
  1. 取 Electron 二进制：先查本机缓存（`~/Library/Caches/electron/`、`release/cache/`），没有就从 npmmirror 下载，用官方 `SHASUMS256.txt` 校验。
  2. 应用代码放进 `resources/app/`（`src/`、`data/`、`package.json`、生产依赖 `playwright-core`），不打 asar。
  3. Windows：`electron.exe` 改名 `MyRTA Rebook.exe`，用纯 JS 的 `resedit` 设置图标和版本信息（开发依赖，不需要 wine）。首次启动时在桌面和开始菜单创建快捷方式（`shell.writeShortcutLink`）。输出 zip。
  4. Mac：`Electron.app` 改名 `MyRTA Rebook.app`，改 `Info.plist`（名称、Bundle ID、版本）和图标 `.icns`。不签名，手册写明去隔离标记的方法。输出 zip，保留可执行权限和符号链接。
- 图标：由现有 `logo.svg` 生成 `.ico` 和 `.icns`，生成结果入库，打包时不再转换。
- 版本号来自 `package.json`。
- zip 继续用 `scripts/zip.ts`（UTF-8 文件名标志），补充符号链接支持（Mac 的 `.app` 里有）。
- Electron 版本固定为 38.7.2，安装依赖时设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，开发时运行的二进制也从缓存取。

## 7. 测试

- 现有 203 个测试在 Electron 内置 Node 里全部通过（`ELECTRON_RUN_AS_NODE=1` 运行 vitest），同时继续在 Node 24 里通过。
- 新增单元测试：授权（签名正确/被改/过期/悉尼时区边界/时间被调回）、翻译表一致性、状态代码翻译与旧数据兼容、刷新预计时间估算、考点上限 2 个、旧数据库升级、`probe` 目录改名复用。
- Electron 主进程：窗口只允许本地地址、退出时调用 `app.stop()`，用可替换依赖测关键逻辑。
- 联网验证（Mac 包，遵守 `docs/HANDOFF.md` 的联网测试规则）：
  1. 打包 → 解压（带隔离标记）→ 打开 `.app` → 导入授权 → 添加 Du → 刷新一轮；
  2. Chrome 最小化是否被拦；
  3. 5 个学员调度不联网验证：用假会话 + 真实 `Service`/`Scheduler`/`Limiter` 跑集成测试，检查 5 个学员 × 3 个考点的排队顺序、20 秒间隔和预计时间。不用假的 Booking number 访问站点（反复登录失败可能被站点标记）；
  4. 关窗口确认 → 所有 Chrome 关闭；
  5. 升级：替换程序后重新打开，Du 自动继续刷新，轮数保留；
  6. 全新会话核对 Du 预约未变。绝不点 Finish。
- Windows 包需要真机走一遍（用户或教练）。

## 不做

- 学员刷新改用 Electron 内置浏览器（实验已证明会被拦）。
- 联网激活、绑定电脑、限制学员数。
- 自动更新、旧版本数据导入。
- 代码签名（Windows 会提示"未知发布者"，Mac 需去隔离标记，手册说明）。
