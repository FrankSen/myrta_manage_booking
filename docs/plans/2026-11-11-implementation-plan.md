# myRTA 改约工具 实现计划

> 执行方式：逐个任务做，每个任务先写失败的测试，再写实现，通过后提交。步骤用复选框跟踪。

**目标：** 在教练的 Windows PC 上，按每个学员的目标考点和时间持续刷新 myrta.com，出现完全符合的考位就自动改约，出现接近的考位就通知教练确认。

**架构：** Node.js 本地后台程序，加一个本地网页界面（Chrome 的 `--app` 窗口显示，没有地址栏）。用 Playwright 通过调试端口接管本机正常启动的 Chrome/Edge（直接由 Playwright 启动的浏览器会被 Akamai 返回 403）。业务判断是纯函数，站点操作集中在适配层。

**技术栈：** Node 24（直接运行 `.ts`，不编译）、TypeScript 7（只做类型检查）、`node:sqlite`、`playwright-core` 1.65.0、vitest 5。

**依据：** `docs/requirements-architecture.md`

## 全局约束

- 考位开始时间距现在不足 48 小时，一律不改（R1）。
- 原考试距现在不足 48 小时，预约锁定，停止该学员任务（R2）。
- 浏览器固定英文环境：启动参数 `--lang=en-AU`，提交登录前确认 `#widget_input_bookingId` 和 `#widget_input_familyName` 存在（控件已初始化）。
- 默认 2 个学员、2 分钟间隔（±20% 抖动）、全局最短访问间隔 20 秒，都放在隐藏配置里。
- 近似容差默认：距离 10 公里、时间 60 分钟、日期 0 天，可调。
- **自动改约默认关闭**（`autoRebookEnabled: false`）。关闭时程序只走到确认页就停，不点 Finish。第一次真实改约由教练通知后再做。
- 一个改约成功的学员，任务立即结束。
- Booking number、姓氏、聊天内容不写进代码、测试、夹具或文档。测试用假数据（如 `1234567890` / `Testsurname`）。运行时数据放 `runtime/`，已在 `.gitignore`。
- 不做绕过验证码的功能。遇到验证码或不认识的页面，暂停并通知教练。
- 目录规则：`src/domain` 纯函数，不读时钟、不访问网络；`src/site` 是唯一知道页面结构的地方。

## 当前进度

| 任务 | 状态 |
|---|---|
| 1 脚手架 + 领域层 | **已完成**（提交 `42a4a2c`，39 个测试通过） |
| 2–9 | 未开始 |

## 阻塞项（需要先处理）

**myrta.com 目前对这台开发机返回 403 或连接重置。** 探索阶段短时间内多次登录，可能触发了 Akamai 的临时限制；也可能是网络波动。影响：任务 5（采集页面夹具）和任务 6（联网冒烟测试）要等访问恢复。任务 2、3、4、7、8 不依赖站点，可以先做。恢复访问前不要再反复访问，以免延长封锁。

## 文件结构

```
src/
  domain/   types.ts  time.ts  geo.ts  matcher.ts           ← 已完成
  config/   settings.ts                                      ← 已完成
  storage/  crypto.ts ← 已完成   db.ts  repo.ts              ← 任务 2
  scheduler/ clock.ts  queue.ts  limiter.ts                  ← 任务 3
  site/     parse.ts  flow.ts  browser.ts  errors.ts         ← 任务 5、6
  engine/   checker.ts  rebook.ts                            ← 任务 4、7
  notify/   notifier.ts                                      ← 任务 8
  ui/       server.ts  public/index.html  public/app.js      ← 任务 8
  main.ts                                                    ← 任务 9
test/       与 src 对应；test/fixtures/ 放脱敏后的页面片段
data/       nsw-test-centres.json（已有）
scripts/    smoke.ts（联网冒烟，手动运行）
```

---

## 任务 2：本地存储

**文件：** 创建 `src/storage/db.ts`、`src/storage/repo.ts`、`test/repo.test.ts`

**接口：**
- 使用：`encrypt/decrypt/loadOrCreateKey`（`src/storage/crypto.ts`），`Target`、`BookingInfo`（`src/domain/types.ts`）
- 提供：

```ts
export type StudentStatus = 'idle' | 'running' | 'pending_confirm' | 'done' | 'stopped' | 'paused';

export interface Student {
  id: number;
  label: string;            // 教练自己看的备注，不放全名
  bookingId: string;        // 解密后的值
  surname: string;          // 解密后的值
  current: BookingInfo;     // 当前预约
  target: Target;
  status: StudentStatus;
  statusNote: string;
}

export interface Offer {   // 待教练确认的接近考位
  id: number; studentId: number;
  centreId: number; date: string; time: string;
  notes: string[]; createdAt: number; state: 'open' | 'accepted' | 'dismissed' | 'gone';
}

export function openDb(path: string): DatabaseSync;               // 建表，WAL 模式
export class Repo {
  constructor(db: DatabaseSync, key: Buffer);
  addStudent(s: Omit<Student, 'id' | 'status' | 'statusNote'>): number;
  getStudent(id: number): Student | undefined;
  listStudents(): Student[];
  updateTarget(id: number, target: Target): void;
  setStatus(id: number, status: StudentStatus, note?: string): void;
  setCurrent(id: number, current: BookingInfo): void;
  deleteStudent(id: number): void;
  addOffer(o: Omit<Offer, 'id' | 'createdAt' | 'state'>, nowMs: number): number | null; // 同一学员同一考位已有 open 的则返回 null
  listOffers(studentId?: number): Offer[];
  setOfferState(id: number, state: Offer['state']): void;
  log(studentId: number | null, level: 'info' | 'warn' | 'error', msg: string, nowMs: number): void;
  recentLogs(limit: number): { at: number; studentId: number | null; level: string; msg: string }[];
}
```

- [ ] **步骤 1：写失败的测试。** 用 `:memory:` 数据库和一个固定密钥。要覆盖：
  1. 新增学员后 `getStudent` 取回的 `bookingId`、`surname` 与输入一致；
  2. 直接用 SQL 读 `students` 表的 `booking_id_enc` 列，内容不包含明文；
  3. `addOffer` 对同一学员、同一考位、同一时间重复添加，第二次返回 `null`；
  4. `setOfferState(id, 'dismissed')` 后再 `addOffer` 同一考位，仍返回 `null`（教练忽略过的不再反复提醒）；
  5. `deleteStudent` 同时删除该学员的 offers；
  6. `recentLogs(2)` 只返回最新两条，按时间倒序。
- [ ] **步骤 2：运行 `npx vitest run test/repo.test.ts`，确认失败（模块不存在）。**
- [ ] **步骤 3：实现。** 表：`students(id, label, booking_id_enc, surname_enc, current_json, target_json, status, status_note)`、`offers(id, student_id, centre_id, date, time, notes_json, created_at, state, UNIQUE(student_id, centre_id, date, time))`、`logs(id, at, student_id, level, msg)`。`addOffer` 用 `INSERT OR IGNORE`，看 `changes` 判断是否新增。外键开启，`offers` 对 `students` 级联删除。
- [ ] **步骤 4：运行测试，全部通过；运行 `npm run typecheck`。**
- [ ] **步骤 5：提交** `feat: 本地存储，敏感字段加密`

---

## 任务 3：调度器

**文件：** 创建 `src/scheduler/clock.ts`、`src/scheduler/limiter.ts`、`src/scheduler/queue.ts`、`test/scheduler.test.ts`

**接口：**
- 使用：`HiddenSettings`（`src/config/settings.ts`）
- 提供：

```ts
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }
export const realClock: Clock;
export class FakeClock implements Clock {   // 测试用，advance() 触发到期的 sleep
  constructor(start?: number); now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>;
  advance(ms: number): Promise<void>;
}

/** 全局限速：所有学员共用，保证任意两次访问至少隔 minGapMs；被封后整体退避 */
export class Limiter {
  constructor(clock: Clock, s: Pick<HiddenSettings, 'globalMinGapMs' | 'backoffBaseMs' | 'backoffMaxMs'>);
  acquire(signal?: AbortSignal): Promise<void>;  // 等到可以访问
  reportBlocked(): number;                       // 返回本次退避时长，连续调用翻倍直到上限
  reportOk(): void;                              // 清零退避
}

/** 每个学员一个定时器，间隔 = 基础间隔 × (1 ± jitter)；受学员上限约束 */
export class Scheduler {
  constructor(clock: Clock, s: HiddenSettings, run: (studentId: number) => Promise<void>, random?: () => number);
  start(studentId: number): boolean;     // 超过 maxActiveStudents 返回 false
  stop(studentId: number): void;
  runNow(studentId: number): void;       // 教练确认考位时插队
  activeIds(): number[];
}
```

- [ ] **步骤 1：写失败的测试，全部用 `FakeClock`，不真等。** 覆盖：
  1. `Limiter`：连续两次 `acquire`，第二次要等满 `globalMinGapMs`；
  2. `reportBlocked` 连续三次返回 5、10、20 分钟，到上限后不再增加；`reportOk` 后重新从 5 分钟开始；
  3. 退避期间 `acquire` 一直等待，期满后放行；
  4. `Scheduler.start` 第 3 个学员返回 `false`；
  5. 间隔落在 `[96s, 144s]`（`random` 取 0 和 1 两个极端）；
  6. `run` 抛异常后调度器不停，下一轮照常；
  7. `runNow` 让某学员立刻执行一次，而且不会和正在进行的那次并发（同一学员同一时刻最多一个）；
  8. `stop` 后不再触发，正在 sleep 的被取消。
- [ ] **步骤 2：运行确认失败。**
- [ ] **步骤 3：实现。** `FakeClock.advance` 按到期时间顺序依次唤醒 sleep，每次唤醒后让出事件循环（`await Promise.resolve()`）。
- [ ] **步骤 4：运行测试通过，类型检查通过。**
- [ ] **步骤 5：提交** `feat: 调度器与全局限速`

---

## 任务 4：单个学员的检查逻辑（不含站点）

**文件：** 创建 `src/engine/checker.ts`、`test/checker.test.ts`

**接口：**
- 使用：`evaluate`、`isBookable`（matcher）、`Repo`、`Limiter`、`nearbyCentres`
- 站点能力用接口注入，本任务用假实现测试：

```ts
export interface SiteSession {
  /** 登录并回到"查看预约"页，返回当前预约。失败抛 SiteError */
  login(bookingId: string, surname: string): Promise<BookingInfo>;
  /** 读取某考点在目标日期范围内的所有考位（内部负责翻周），不含已被占用的 */
  listSlots(centreId: number, dateFrom: LocalDate, dateTo: LocalDate): Promise<Slot[]>;
  /** 选定考位并走到确认页，返回确认页上显示的内容。不提交 */
  reachConfirm(slot: Slot): Promise<BookingInfo>;
  /** 点 Finish，返回完成页是否识别为成功 */
  finish(): Promise<'success' | 'failed' | 'unknown'>;
  /** 重新读取预约详情，用来核实改约结果 */
  readCurrent(): Promise<BookingInfo>;
  close(): Promise<void>;
}

export type SiteErrorKind = 'blocked' | 'bad_credentials' | 'widgets_missing' | 'unknown_page' | 'captcha' | 'timeout';
export class SiteError extends Error { constructor(public kind: SiteErrorKind, message: string); }

export interface CheckDeps {
  repo: Repo; limiter: Limiter; clock: Clock;
  openSession(): Promise<SiteSession>;
  tolerance: Tolerance; centres: CentreIndex;
  autoRebookEnabled: boolean;
  notify(event: NotifyEvent): void;
}
export type NotifyEvent =
  | { type: 'offer'; studentId: number; offerId: number }
  | { type: 'rebooked'; studentId: number; to: BookingInfo }
  | { type: 'dry_run_ready'; studentId: number; slot: Slot }   // 自动改约关闭时，停在确认页
  | { type: 'stopped'; studentId: number; reason: string }
  | { type: 'error'; studentId: number; kind: SiteErrorKind };

export async function checkStudent(studentId: number, deps: CheckDeps, session?: SiteSession): Promise<void>;
```

**每轮的流程（按顺序）：**
1. 原考试距现在不足 48 小时 → `stopped`，状态 `stopped`。
2. 目标日期范围内再没有满 48 小时的日子（`dateTo` 当天 23:59 已进入 48 小时线）→ `stopped`。
3. 要查的考点：目标考点每轮全查；附近考点（`nearbyCentres`）每轮轮流查一个（用学员的 `rotation` 游标，存在内存里即可）。
4. 对每个考点：先 `limiter.acquire()`，再 `listSlots`，每个考位用 `evaluate`。
5. 有 `exact`：自动改约开启 → `reachConfirm` → 核对确认页内容和选中的考位一致 → `finish` → `readCurrent` 核实 → 成功则 `done`；自动改约关闭 → 发 `dry_run_ready`，状态 `pending_confirm`，不点 Finish。
6. 只有 `near`：`addOffer`，成功新增才发 `offer` 通知。
7. `SiteError`：`blocked` → `limiter.reportBlocked()`，状态不变；`bad_credentials` / `widgets_missing`（重试一次仍失败）/ `captcha` / `unknown_page` → 状态 `paused`，发 `error` 通知。

- [ ] **步骤 1：写失败的测试，用假 `SiteSession`。** 覆盖：
  1. 原考试 47 小时后 → `stopped`，没调用 `listSlots`；
  2. 只有一个 `exact` 且自动改约**关闭** → 发 `dry_run_ready`，`reachConfirm` 被调用，`finish` **没有**被调用；
  3. 同上但自动改约开启 → `finish` 被调用一次，`readCurrent` 返回新预约才算成功，状态 `done`；
  4. `finish` 返回 `success`，但 `readCurrent` 仍是旧预约 → 不算成功，状态 `paused`，发 `error`；
  5. 确认页显示的时间和所选考位不一致 → 不点 Finish，状态 `paused`；
  6. 同时有 `exact` 和 `near` → 只处理 `exact`；
  7. 两轮都返回同一个 `near` → 只发一次 `offer`；
  8. `SiteError('blocked')` → `limiter.reportBlocked` 被调用一次，学员状态仍是 `running`；
  9. `bad_credentials` → 状态 `paused`；
  10. 附近考点轮流：连续三轮查的附近考点依次是第 1、2、3 个；
  11. 每次 `listSlots` 前都调用了 `limiter.acquire`；
  12. 不足 48 小时的考位被忽略，即使它完全符合。
- [ ] **步骤 2：运行确认失败。**
- [ ] **步骤 3：实现。**
- [ ] **步骤 4：运行测试通过，类型检查通过。**
- [ ] **步骤 5：提交** `feat: 单个学员的检查与改约流程`

---

## 任务 5：站点适配层——页面解析（离线）

**文件：** 创建 `src/site/parse.ts`、`test/parse.test.ts`、`test/fixtures/*.html`

**前置：** 站点访问恢复，且教练同意用一个学员采集夹具。夹具里的姓名、Booking number、电话尾号必须替换为假数据后才能入库。

**接口提供：**

```ts
/** 从选时间页的内联脚本中取出 var timeslots，返回所有考位 */
export function parseTimeslots(html: string): { date: LocalDate; time: LocalTime; available: boolean; slotNumber: number }[];
/** 读取当前显示的周一日期（formTableWeekStarting） */
export function parseWeekStart(html: string): LocalDate;
/** "There are no timeslots available at this location." */
export function hasNoTimeslotsMessage(html: string): boolean;
/** 登录后"查看预约"页：当前考点、日期、时间 */
export function parseBookingSummary(text: string): BookingInfo;
/** 确认页：考点、日期、时间 */
export function parseConfirmPage(text: string): BookingInfo;
/** 判断页面类型，识别不了就是 'unknown' */
export function detectPage(text: string, url: string): 'login' | 'main' | 'choose_location' | 'choose_time' | 'confirm' | 'finish' | 'blocked' | 'unknown';
```

- [ ] **步骤 1：采集夹具。** 手动在浏览器里走流程，保存：选时间页（含考位 JSON）、没有空位的选时间页、查看预约页文字、确认页文字、被拦页（403 的"temporarily unavailable"）。脱敏后放入 `test/fixtures/`。
- [ ] **步骤 2：写失败的测试。** 覆盖：解析出 126 个格子（一周 7 天 × 18，以夹具实际数为准）；`available` 数量与页面一致；`16/11/2026 8:00` 转成 `2026-11-16` / `08:00`；没有空位的提示能被识别；确认页解析出日期 `2026-12-31`、时间 `08:00`；`detectPage` 对 403 页面返回 `blocked`；乱码输入返回 `unknown` 而不是抛错。
- [ ] **步骤 3：实现。** `timeslots` 的提取用花括号配对，不用正则一次匹配整个 JSON（JSON 内可能含 `}`）。
- [ ] **步骤 4：测试通过。**
- [ ] **步骤 5：提交** `feat: 站点页面解析`

---

## 任务 6：站点适配层——浏览器与流程

**文件：** 创建 `src/site/browser.ts`、`src/site/flow.ts`、`src/site/errors.ts`、`scripts/smoke.ts`

**要点（都已在探索中验证过，见需求文档第 3 节）：**
- 启动方式：`child_process.spawn(chromePath, ['--remote-debugging-port=<端口>', '--user-data-dir=<runtime/browser-profile/学员id>', '--lang=en-AU', '--no-first-run', 'about:blank'])`，等端口可连后 `chromium.connectOverCDP`。每个学员一个独立 profile，互不串会话。
- Chrome 路径：Windows 先找 `C:\Program Files\Google\Chrome\Application\chrome.exe`，再找 Edge 的 `msedge.exe`；找不到就报错，提示教练安装。Mac 用 `/Applications/Google Chrome.app/...`。路径可由配置覆盖。
- 登录：首页 → 页面里文字是 "Manage booking" 的链接，**取出 `href` 再 `goto`**（直接点会超时）→ 等 `#widget_input_bookingId` → 逐字输入（每字约 90ms）→ Tab → 点可见的 Continue 按钮。控件等不到 → `SiteError('widgets_missing')`，先重载重试一次。
- 选考点：点 "change location" → 勾 `#rms_batLocLocSel` → `selectOption('select[name=locationSelect]', String(centreId))` → 点 `#rms_testGroupWrapper` 里的 Next。
- 翻周：`#nextWeekButton` / `#prevWeekButton`，每页一周，约 13 秒。起始周通过选考点页的"期望日期"`preferredDateStr`（`#widget_rms_batDateSel`）直接定位，避免从头翻。**这一点还没验证，先用 `getEarliestTime` 或翻周兜底，验证后再优化。**
- 选考位：点 `#rms_<星期>_<时分>` 里的链接（例如 `#rms_thu_800 a`），class 为 `available` 才点；点完 `#selectedDateTime` 应变为 `31/12/2026 8:0`。再点 `#nextButton` 进入确认页。
- 确认页：读页面文字解析；Finish 前要选联系电话（用已登记号码 `existingPhone`）并勾 `#checkTerms`。**Finish 的点击只写在 `finish()` 里，并且只有 `autoRebookEnabled` 为真时调用。**
- 页面类型识别不了、出现验证码、返回 403 → 抛对应的 `SiteError`，不重试点击。

- [ ] **步骤 1：写 `errors.ts`（`SiteError`）和 `browser.ts`（找浏览器、启动、连接、关闭）。** 单元测试只覆盖"找浏览器路径"的纯逻辑（传入存在性检查函数）：Windows 上 Chrome 存在用 Chrome，只有 Edge 用 Edge，都没有抛错。
- [ ] **步骤 2：实现 `flow.ts` 的 `SiteSession`。**
- [ ] **步骤 3：写 `scripts/smoke.ts`，手动运行：** 登录 → 读当前预约 → 选 Silverwater → 读一周考位 → 翻一周 → 选一个考位 → 到确认页 → **停下，打印确认页内容，不点 Finish** → 关闭。环境变量 `SMOKE_BOOKING_ID`、`SMOKE_SURNAME` 提供凭据，不写进文件。
- [ ] **步骤 4：运行冒烟测试，对照 Du 的预约核对：运行前后预约详情不变。**
- [ ] **步骤 5：提交** `feat: 浏览器接管与站点流程（只到确认页）`

---

## 任务 7：状态机与确认考位

**文件：** 修改 `src/engine/checker.ts`；创建 `src/engine/service.ts`、`test/service.test.ts`

**接口提供：**

```ts
export class Service {
  constructor(deps: ServiceDeps);
  startStudent(id: number): boolean;      // 受学员上限约束
  pauseStudent(id: number): void;
  acceptOffer(offerId: number): Promise<'success' | 'gone' | 'failed'>;  // 教练确认接近考位：插队，重新读该考点，考位还在才改
  dismissOffer(offerId: number): void;
  stopAll(): Promise<void>;
}
```

规则：改约成功后该学员状态 `done`，从调度器移除，其浏览器会话关闭；`acceptOffer` 在考位已不在列表里时标记 `gone`；**教练确认的接近考位同样受 `autoRebookEnabled` 约束，关闭时只走到确认页并提示。**

- [ ] **步骤 1：写失败的测试（假 `SiteSession`）。** 覆盖：成功后学员不再被调度；`acceptOffer` 考位还在 → 改约；考位已没了 → `gone`；`pauseStudent` 后不再调度；超过上限的 `startStudent` 返回 `false`；`stopAll` 关闭所有会话。
- [ ] **步骤 2–4：** 运行失败 → 实现 → 通过。
- [ ] **步骤 5：提交** `feat: 学员状态机与教练确认流程`

---

## 任务 8：通知与本地界面

**文件：** 创建 `src/notify/notifier.ts`、`src/ui/server.ts`、`src/ui/public/index.html`、`src/ui/public/app.js`、`test/ui.test.ts`

**设计：**
- `server.ts` 用 `node:http`，只监听 `127.0.0.1`，启动时生成随机访问令牌，页面和接口都要带令牌，避免同一台电脑上别的程序乱调。
- 接口（JSON）：`GET /api/students`、`POST /api/students`、`PUT /api/students/:id/target`、`POST /api/students/:id/start|pause`、`DELETE /api/students/:id`、`GET /api/offers`、`POST /api/offers/:id/accept|dismiss`、`GET /api/logs`；事件推送用 Server-Sent Events：`GET /api/events`。
- 界面：学员列表（状态、当前预约、目标）、新增/编辑学员（目标考点从 110 个考点里选，日期范围，时间段）、待确认考位（接受/忽略，显示偏差说明）、日志。界面里**不显示**学员上限和检查间隔。
- 通知：界面页面里用浏览器 `Notification` API 弹系统通知（Windows 右下角），同时页面内高亮。首次打开需授权。
- 启动窗口：`chrome --app=http://127.0.0.1:<端口>/?t=<令牌> --user-data-dir=<runtime/ui-profile>`，与控制 myrta 的浏览器用不同 profile。

- [ ] **步骤 1：写失败的测试。** 覆盖：没带令牌的请求返回 401；新增学员后 `GET /api/students` 返回的是脱敏数据（不含完整 Booking number，只返回末 3 位）；`PUT target` 校验日期范围（`dateFrom <= dateTo`，时间段 `timeFrom < timeTo`），不合法返回 400；`accept` 一个不存在的 offer 返回 404；SSE 能收到一条 `offer` 事件。
- [ ] **步骤 2–4：** 运行失败 → 实现 → 通过。
- [ ] **步骤 5：手动检查界面，用浏览器打开并走一遍新增、编辑、启动、暂停。**
- [ ] **步骤 6：提交** `feat: 本地界面与通知`

---

## 任务 9：装配、Windows 打包与文档

**文件：** 创建 `src/main.ts`、`scripts/build-windows.ts`、`runtime/` 不入库、`docs/user-guide.md`

- [ ] **步骤 1：`main.ts`：** 读 `runtime/settings.json`（可选，用 `mergeSettings` 合并）→ 打开数据库和密钥 → 创建 `Service` 和界面服务 → 打开界面窗口 → 处理退出信号，关闭所有浏览器。启动时先检查是否已有实例在运行（锁文件），避免重复启动重复访问站点。
- [ ] **步骤 2：** 打包脚本：把 `src/`、`data/`、`node_modules`（只含生产依赖）、Windows 版 `node.exe` 放进一个文件夹，加 `启动.bat`。`node.exe` 从 `https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip` 下载（实测约 0.5MB/s，需要几分钟；`cdn.npmmirror.com/binaries/node/` 约 8MB/s，更快）。
- [ ] **步骤 3：** 写 `docs/user-guide.md`：怎么安装、怎么新增学员、怎么看通知、常见问题（找不到浏览器、被拦截）。
- [ ] **步骤 4：** 在 Windows 机器或虚拟机上完整走一遍。
- [ ] **步骤 5：提交** `feat: 程序入口与 Windows 打包`

---

## 任务 10：第一次真实改约（等教练通知后进行）

**不属于开发阶段。** 开发全部完成后，教练通知，才执行：

1. 教练选定一个学员，提前通知学员，只改到 48 小时以外的时间。
2. 教练在场，开启 `autoRebookEnabled`，对这一个学员运行。
3. 记录并补全：完成页的文字和识别规则、改约次数限制和费用、原考位是否释放、会话超时时长。
4. 把这些写回 `docs/requirements-architecture.md` 第 3 节，并补上 `detectPage` 对完成页的夹具和测试。
5. 确认无误后，再决定是否默认开启自动改约。

---

## 自检

**需求覆盖：** F1–F2（学员与目标）→ 任务 2、8；F3（持续刷新）→ 任务 3、4；F4（自动改约）→ 任务 4、6；F5（接近考位教练确认）→ 任务 4、7、8；F6（成功即终止）→ 任务 4、7；F7（Windows，跨平台）→ 任务 6、9；F8（桌面通知）→ 任务 8；R1–R3 → 任务 1（已完成）、4；隐藏配置 → 任务 1（已完成）、3；近似容差 → 任务 1（已完成）。

**已知未验证的点：** ① 选考点页设期望日期能否直接定位到目标周；② 完成页的样子；③ 会话超时时长；④ Akamai 对本工具访问频率的容忍度；⑤ Windows 上 Chrome/Edge 的调试端口启动方式。①②③⑤ 在任务 6 和 10 中验证，④ 靠运行中观察和自动退避。
