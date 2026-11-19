import type { Page } from 'playwright-core';
import { addDays, mondayOf, parseSiteDate, slotCellTime, weekdayKey } from '../domain/time.ts';
import type { BookingInfo, LocalDate, Slot } from '../domain/types.ts';
import { launchBrowser, setWindowState, type BrowserHandle } from './browser.ts';
import { SiteError } from './errors.ts';
import { errorText, msg } from '../i18n.ts';
import { detectPage, freshText, hasNoTimeslotsMessage, loginProblem, hasTimeslotsData, parseBookingDetails, parseTimeslots, parseWeekStarting, weekNavUrl, type PageKind } from './parse.ts';
import type { SiteSession } from './session.ts';

const HOME = 'https://www.myrta.com/';
/** 站点有时很慢（实测首页 DOMContentLoaded 要 40 秒），超时要放宽；不等整页 load，只等文档可用 */
const NAV_TIMEOUT = 90_000;

/**
 * "Manage booking" 深链接。所有学员、所有会话共用一个，首次从首页抓到后缓存，
 * 之后直接跳转、省掉首页那一跳（2026-11-17 教练要求）。链接失效时回退到首页重新抓。按首页地址分开存
 */
const cachedManageHref = new Map<string, string>();

/**
 * 确认页（2026-11-19 联网实测，只勾选没提交）：联系电话"Use this number"单选框（默认已选中）、
 * 条款勾选框、Finish 是 Dojo 按钮 #nextButton（文字 Finish）。提交后的完成页还没见过
 */
const PHONE_ON_FILE = '#rms_batCon-onFile';
const TERMS = '#checkTerms';
const FINISH_BUTTON = '#nextButton';

/**
 * 停在选时间页时，多久回"查看预约"页重新读一次预约。在软件外改了约要靠这个发现；
 * 等别人让出考位的学员自己在查那个考位，不靠它
 */
export const CURRENT_REFRESH_MS = 10 * 60_000;

/**
 * 停在某个考点的选时间页。之后刷新、翻周都在页面里直接请求（站点记住当前看到哪一周，
 * 每次返回的页面里带着翻周地址），不再点页面、不渲染。2026-11-19 联网实测：每次约 2.5–3 秒，
 * 点页面翻周要 6.5 秒，从预约页走过来查一周要 17 秒
 */
interface Parked {
  centreId: number;
  /** 刷新当前周用的地址（最近一次返回的页面地址） */
  url: string;
  /** 最近一次拿到的选时间页 HTML */
  html: string;
  /** 站点现在停在哪一周 */
  week: LocalDate;
  /** html 是不是刚拿到的（这一轮还没用过） */
  fresh: boolean;
  /** 浏览器里显示的页面是不是最新的（在页面里请求过之后就不是了，选位前要重新载入） */
  domFresh: boolean;
}

export interface FlowOptions {
  profileDir: string;
  /** 为 true 时 finish() 才会真正点 Finish。第一次真实改约验证之前不要打开 */
  allowFinish: boolean;
  /** 网站首页，默认真实的 myrta.com。测试时指向本地假网站 */
  home?: string;
  /** 测试时替换，默认真实启动浏览器 */
  launch?: (profileDir: string) => Promise<BrowserHandle>;
  /** 测试时替换 */
  now?: () => number;
  currentRefreshMs?: number;
  /** 每次页面内请求前调用（全局限速）；没有时直接请求 */
  throttle?: () => Promise<void>;
}

/** 每个学员一个会话：一个独立的浏览器窗口，登录后复用 */
export class BrowserSession implements SiteSession {
  private readonly opts: FlowOptions;
  private handle: BrowserHandle | null = null;
  private loggedIn = false;
  /** 最近一次登录用的资料：提交后停在完成页、回不到预约页时，重新登录读取预约 */
  private creds: { bookingId: string; surname: string } | null = null;
  private parked: Parked | null = null;
  private throttle: (() => Promise<void>) | null = null;
  /** 最近一次读到的预约和读取时间：停在选时间页时 login() 直接返回它 */
  private current: BookingInfo | null = null;
  private currentAt = 0;
  /** 最近一次 listSlots 是否在页面里直接请求（没有点页面） */
  lastListFast = false;
  /** 选定考位、停在确认页时，记录所选考位，防止 finish() 在没选位时被调用 */
  private pending: Slot | null = null;
  /** 最近一次 login() 是否复用了已有的登录（没有重新输入资料）。用于观察会话能保持多久 */
  lastLoginReused = false;
  /** 最近一次 listSlots 每一周看到的情况，用于排查"读到 0 个考位"是真的没有还是读错了 */
  lastListWeeks: { weekStart: LocalDate | null; total: number; available: number; inRange: number; noSlotsMessage: boolean }[] = [];

  constructor(opts: FlowOptions) {
    this.opts = opts;
  }

  private async page(): Promise<Page> {
    if (!this.handle) this.handle = await (this.opts.launch ?? launchBrowser)(this.opts.profileDir);
    return this.handle.page;
  }

  async login(bookingId: string, surname: string): Promise<BookingInfo> {
    const page = await this.page();
    this.creds = { bookingId, surname };
    // 会话还有效：直接回到"查看预约"页，不用重新登录
    this.lastLoginReused = false;
    // 停在选时间页、预约刚读过：不离开选时间页（回预约页要 19 秒，再走回来又要十几秒）
    const now = (this.opts.now ?? Date.now)();
    if (this.loggedIn && this.parked && this.current && now - this.currentAt < (this.opts.currentRefreshMs ?? CURRENT_REFRESH_MS)) {
      this.lastLoginReused = true;
      return this.current;
    }
    if (this.loggedIn) {
      if (await this.tryReturnToMain(page)) {
        this.lastLoginReused = true;
        return this.readSummary(page);
      }
      this.loggedIn = false;
    }

    // 先走缓存的 Manage booking 深链接，省掉首页那一跳；失效再回退到首页重新抓
    const home = this.home();
    if (!(await this.gotoLoginForm(page, cachedManageHref.get(home) ?? null))) {
      cachedManageHref.delete(home);
      if (!(await this.gotoLoginForm(page, null))) throw new SiteError('unknown_page', msg('err.no_manage_link'));
    }

    const idBox = page.locator('#widget_input_bookingId');
    const nameBox = page.locator('#widget_input_familyName');
    // 逐字输入，像真人一样；整体粘贴有时不触发控件的校验
    await idBox.click();
    await page.keyboard.type(bookingId, { delay: 90 });
    await nameBox.click();
    await page.keyboard.type(surname, { delay: 90 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    const before = await page.innerText('body').catch(() => '');
    // 站点慢时，点击后等页面跳转会超时（2026-11-19 实测 30 秒）。先点一下，如果点击本身超时，
    // 再等一小会看是否其实点到了（页面已经跳转），没有再报超时。比直接吞掉更准
    try {
      await page.locator('#searchBookingCriteria').getByRole('button', { name: /continue/i }).click({ timeout: 8_000 });
    } catch (err) {
      if (!/Timeout/i.test(String((err as Error)?.message ?? err))) throw err;
      // 点击超时：可能网站慢、按钮点了没反应，也可能点击其实生效了只是没跳到。再等 8 秒
      const after = await page.waitForURL(/tbs-change-main/, { timeout: 8_000 }).then(() => 'main' as const).catch(() => null);
      if (after) {
        this.loggedIn = true;
        return this.readSummary(page);
      }
      throw new SiteError('timeout', msg('err.login_click_timeout'));
    }
    await this.waitForMain(page, before);
    await page.waitForLoadState('domcontentloaded');
    this.loggedIn = true;
    return this.readSummary(page);
  }

  async listSlots(centreId: number, dateFrom: LocalDate, dateTo: LocalDate): Promise<Slot[]> {
    const page = await this.page();
    this.lastListWeeks = [];
    this.lastListFast = this.parked?.centreId === centreId;
    if (!this.lastListFast) {
      await this.openChooseTime(page, centreId, dateFrom);
      await this.park(page, centreId);
    }
    const p = this.parked!;
    // 站点一次显示一周：先到开始那一周，再一周一周往后，直到超过结束日期
    await this.moveTo(page, mondayOf(dateFrom));
    const result: Slot[] = [];
    const seen = new Set<string>();
    for (let guard = 0; guard < 20; guard++) {
      p.fresh = false;
      if (!hasTimeslotsData(p.html)) {
        // 选时间页没有考位数据：站点明确说没有考位才算没有，否则是页面不对
        if (!hasNoTimeslotsMessage(p.html)) throw new SiteError('unknown_page', msg('err.no_slots_data'));
        this.lastListWeeks.push({ weekStart: p.week, total: 0, available: 0, inRange: 0, noSlotsMessage: true });
        break;
      }
      const raw = parseTimeslots(p.html);
      let inRange = 0;
      for (const s of raw) {
        if (!s.available || s.date < dateFrom || s.date > dateTo) continue;
        inRange++;
        const key = `${s.date} ${s.time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ centreId, date: s.date, time: s.time });
      }
      this.lastListWeeks.push({ weekStart: p.week, total: raw.length, available: raw.filter((s) => s.available).length, inRange, noSlotsMessage: false });
      if (addDays(p.week, 7) > dateTo) break;
      await this.fetchWeek(page, 'next');
    }
    return result;
  }

  async reachConfirm(slot: Slot): Promise<BookingInfo> {
    const page = await this.page();
    // listSlots 刚读完：站点停在这个考点的选时间页。先让站点翻到考位那一周，再把页面重新载入成那一周，然后点格子
    const p = this.parked;
    if (p && p.centreId === slot.centreId) {
      await this.moveTo(page, mondayOf(slot.date));
      p.fresh = false;
      if (!p.domFresh) {
        await this.go(page, p.url);
        await this.waitTimeslotsDom(page);
        p.domFresh = true;
      }
    }
    await this.expectKind(page, 'choose_time');
    await this.goToWeek(page, slot.date);
    // 下面要点页面，离开选时间页
    this.parked = null;

    const id = `#rms_${weekdayKey(slot.date)}_${slotCellTime(slot.time)}`;
    const cell = page.locator(`${id} a`);
    if ((await cell.count()) === 0 || !(await cell.first().getAttribute('class'))?.includes('available')) {
      throw new SiteError('slot_gone', msg('err.slot_unavailable', { date: slot.date, time: slot.time }));
    }
    await cell.first().click();
    await page.waitForTimeout(300);
    await this.clickAndLoad(page, '#nextButton');
    await this.expectKind(page, 'confirm');
    this.pending = slot;
    return parseBookingDetails(await page.innerText('body'));
  }

  async finish(): Promise<'success' | 'failed' | 'unknown'> {
    if (!this.opts.allowFinish) {
      throw new SiteError('unknown_page', msg('err.finish_disabled'));
    }
    if (!this.pending) throw new SiteError('unknown_page', msg('err.no_pending'));
    const page = await this.page();
    await this.expectKind(page, 'confirm');
    const notSubmitted = (key: string) => new SiteError('not_submitted', msg(key));

    // 联系方式用网站上已登记的号码（默认已选中），再勾选条款（2026-11-17 教练：联系方式已经存在网站上）
    const phone = page.locator(PHONE_ON_FILE);
    if ((await phone.count()) === 0) throw notSubmitted('err.finish_no_phone');
    if (!(await phone.first().isChecked())) await phone.first().check();
    if (!(await phone.first().isChecked())) throw notSubmitted('err.finish_no_phone');
    const terms = page.locator(TERMS);
    if ((await terms.count()) === 0) throw notSubmitted('err.finish_no_terms');
    if (!(await terms.first().isChecked())) await terms.first().check();
    if (!(await terms.first().isChecked())) throw notSubmitted('err.finish_no_terms');
    await page.waitForTimeout(200);
    const button = page.locator(FINISH_BUTTON);
    if ((await button.count()) === 0 || !/finish/i.test(await button.first().innerText().catch(() => ''))) throw notSubmitted('err.finish_no_button');

    // 从这里开始可能已经提交。结果只是页面的说法，调用方必须再用 readCurrent 核实
    const before = await page.innerText('body').catch(() => '');
    this.pending = null;
    // 点击本身出错也当作可能已提交，照样去看结果；调用方最终用 readCurrent 核实
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}),
      button.first().click({ timeout: 20_000 }).catch(() => {}),
    ]);
    for (let i = 0; i < 60; i++) {
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      const text = await page.innerText('body').catch(() => '');
      const kind = detectPage(text, page.url());
      if (kind === 'finish') return 'success';
      if (kind === 'blocked') throw new SiteError('blocked', msg('kind.blocked'));
      if (kind === 'captcha') throw new SiteError('captcha', msg('kind.captcha'));
      // 回到选时间页：考位在提交前被别人抢走了
      if (kind === 'choose_time' || /no longer available/i.test(text)) return 'failed';
      // 还在确认页且出现了新的提示：多半是没填全，把网站原话告诉教练
      if (kind === 'confirm' && i >= 3) {
        const extra = freshText(before, text);
        if (extra) throw new SiteError('unknown_page', msg('err.finish_site_says', { text: extra }));
      }
      await page.waitForTimeout(1000);
    }
    return 'unknown';
  }

  async readCurrent(): Promise<BookingInfo> {
    const page = await this.page();
    if (await this.tryReturnToMain(page)) return this.readSummary(page);
    // 提交后停在完成页，没有返回按钮：重新登录读取
    if (!this.creds) throw new SiteError('unknown_page', msg('err.no_main'));
    this.loggedIn = false;
    return this.login(this.creds.bookingId, this.creds.surname);
  }

  async reveal(): Promise<void> {
    if (this.handle) await setWindowState(this.handle.page, 'normal');
  }

  setThrottle(fn: () => Promise<void>): void {
    this.throttle = fn;
  }

  async conceal(): Promise<void> {
    if (this.handle && process.env.MYRTA_MINIMIZE !== '0') await setWindowState(this.handle.page, 'minimized');
  }

  async close(): Promise<void> {
    this.loggedIn = false;
    this.pending = null;
    this.parked = null;
    const h = this.handle;
    this.handle = null;
    await h?.close();
  }

  // ---- 内部 ----

  private home(): string {
    return this.opts.home ?? HOME;
  }

  /** 页面现在是这个考点的选时间页：记下来，之后在页面里直接请求 */
  private async park(page: Page, centreId: number): Promise<void> {
    await this.waitTimeslotsDom(page);
    const html = await page.content();
    const week = parseWeekStarting(html) ?? parseSiteDate(await page.locator('#formTableWeekStarting').inputValue());
    this.parked = { centreId, url: page.url(), html, week, fresh: true, domFresh: true };
  }

  /** 让站点停到 want 那一周。已经在那一周且数据是刚拿到的就不再请求，否则刷新一次 */
  private async moveTo(page: Page, want: LocalDate): Promise<void> {
    const p = this.parked!;
    if (p.week === want) {
      if (!p.fresh) await this.fetchWeek(page, 'same');
      return;
    }
    for (let i = 0; i < 20 && p.week !== want; i++) {
      const before = p.week;
      await this.fetchWeek(page, p.week < want ? 'next' : 'prev');
      // 翻不动了（站点最早只到当前这一周）
      if (p.week === before) break;
    }
  }

  /**
   * 在页面里直接请求选时间页：same 刷新当前周，next/prev 翻周。不渲染、不点页面。
   * 拿到的不是选时间页（会话过期等）：不再停在这里，按超时处理，下一轮重新登录走完整流程
   */
  private async fetchWeek(page: Page, dir: 'same' | 'next' | 'prev'): Promise<void> {
    const p = this.parked!;
    const url = dir === 'same' ? p.url : weekNavUrl(p.html, dir);
    const lost = () => {
      this.parked = null;
      this.loggedIn = false;
      this.current = null;
      return new SiteError('timeout', msg('err.parked_lost'));
    };
    if (!url) throw lost();
    const throttle = this.throttle ?? this.opts.throttle;
    if (throttle) await throttle();
    let res: { status: number; url: string; text: string };
    try {
      res = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        return { status: r.status, url: r.url, text: await r.text() };
      }, url);
    } catch (err) {
      this.parked = null;
      throw new SiteError('timeout', msg('err.open_failed', { detail: errorText(err) }));
    }
    if (res.status === 403) {
      this.parked = null;
      throw new SiteError('blocked', msg('err.http_403'));
    }
    const kind = detectPage(res.text, res.url);
    if (kind === 'blocked' || kind === 'captcha') {
      this.parked = null;
      throw new SiteError(kind, msg(`kind.${kind}`));
    }
    const week = parseWeekStarting(res.text);
    if (!week || !(hasTimeslotsData(res.text) || hasNoTimeslotsMessage(res.text))) throw lost();
    Object.assign(p, { html: res.text, week, url: res.url || p.url, fresh: true, domFresh: false });
  }

  /** 等选时间页的考位数据出现在浏览器里（或站点说没有考位） */
  private async waitTimeslotsDom(page: Page): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const html = await page.content().catch(() => '');
      if (hasTimeslotsData(html) || hasNoTimeslotsMessage(html)) return;
      await page.waitForTimeout(500);
    }
    throw new SiteError('unknown_page', msg('err.no_slots_data'));
  }

  /**
   * 走到登录表单页（Booking number / Family name 输入框出现）。
   * href 有值：直接跳转这个深链接，省掉首页；href 为 null：从首页抓链接再跳并缓存。
   * 表单没出现（链接失效或抓不到）返回 false，让调用方回退。被拦/验证码仍然抛错
   */
  private async gotoLoginForm(page: Page, href: string | null): Promise<boolean> {
    if (href) {
      // 直接点这个链接会超时，取出地址直接跳转
      await this.go(page, href);
      await this.assertNotBlocked(page);
      return this.loginFormVisible(page);
    }
    await this.go(page, this.home());
    await this.assertNotBlocked(page);
    // 站点慢的时候，正文先出来，链接要过一会儿才有，所以要等
    let found: string | null = null;
    for (let i = 0; i < 60 && !found; i++) {
      found = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find((x) => /^\s*Manage booking\s*$/i.test(x.textContent ?? ''));
        return a ? (a as HTMLAnchorElement).href : null;
      }).catch(() => null);
      if (!found) await page.waitForTimeout(1000);
    }
    if (!found) return false;
    await this.go(page, found);
    await this.assertNotBlocked(page);
    if (!(await this.loginFormVisible(page))) return false;
    // 抓到且确实走到登录表单才缓存，供下一个会话直接用
    cachedManageHref.set(this.home(), found);
    return true;
  }

  /** 登录表单的 Booking number 输入框是否在限时内出现 */
  private async loginFormVisible(page: Page): Promise<boolean> {
    try {
      await page.locator('#widget_input_bookingId').waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** 从"查看预约"页出发：选考点页 → 选时间页。期望日期设为 from，直接定位到那一周 */
  private async openChooseTime(page: Page, centreId: number, from: LocalDate): Promise<void> {
    if (!(await this.tryReturnToMain(page))) throw new SiteError('unknown_page', msg('err.no_main'));
    // "Change location" 是 Dojo 按钮不是链接，控件初始化后才会出现
    const changeBtn = page.locator('#changeLocationButton_label');
    try {
      await changeBtn.waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      throw new SiteError('unknown_page', msg('err.no_change_location'));
    }
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}),
      changeBtn.click(),
    ]);
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    await this.expectKind(page, 'choose_location');
    // 日期控件是 Dojo 的，页面出来后还要一点时间初始化
    await page.waitForTimeout(600);

    // 期望日期决定站点从哪一周开始显示。必须像真人一样在输入框里键入；
    // 用脚本直接给控件赋值不会生效，而且不报错，会静默落到当前预约所在的那一周
    const [y, m, d] = from.split('-') as [string, string, string];
    const wanted = `${d}/${m}/${y}`;
    const dateBox = page.locator('#widget_rms_batDateSel');
    await dateBox.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(wanted, { delay: 80 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    const stored = await page.locator('input[name=preferredDateStr]').inputValue();
    if (stored !== wanted) {
      throw new SiteError('unknown_page', msg('err.date_not_set', { wanted, stored }));
    }
    await page.locator('#rms_batLocLocSel').check();
    await page.waitForTimeout(600);
    await page.selectOption('select[name=locationSelect]', String(centreId));
    await page.waitForTimeout(800);
    await this.clickAndLoad(page, '#rms_testGroupWrapper >> role=button[name=/next/i]');
    await this.expectKind(page, 'choose_time');
  }

  /**
   * 点 Continue 后等进入"查看预约"页。资料不对时站点留在登录页显示提示，不跳转：
   * 每秒看一次，看到提示立刻报错，不干等到超时
   */
  private async waitForMain(page: Page, before: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (/tbs-change-main/.test(page.url())) return;
      const text = await page.innerText('body').catch(() => '');
      const kind = detectPage(text, page.url());
      if (kind === 'blocked') throw new SiteError('blocked', msg('kind.blocked'));
      if (kind === 'captcha') throw new SiteError('captcha', msg('kind.captcha'));
      const p = loginProblem(before, text);
      if (p?.kind === 'widgets_missing') throw new SiteError('widgets_missing', msg('err.mandatory'));
      if (p?.kind === 'bad_credentials') throw new SiteError('bad_credentials', msg('err.bad_credentials_site', { text: p.line }));
      const waited = Date.now() - start;
      // 还在登录页、已经过了 20 秒、页面上出现了新文字：多半是站点的提示，只是说法没见过，把原话告诉教练
      if (waited > 20_000 && kind === 'login') {
        const extra = freshText(before, text);
        if (extra) throw new SiteError('unknown_page', msg('err.login_site_says', { text: extra }));
      }
      if (waited > 90_000) throw await this.explainLoginFailure(page);
      await page.waitForTimeout(1000);
    }
  }

  /** 提交登录后没有进入"查看预约"页，判断是什么原因 */
  private async explainLoginFailure(page: Page): Promise<SiteError> {
    const kind = await this.currentKind(page);
    if (kind === 'blocked') return new SiteError('blocked', msg('kind.blocked'));
    if (kind === 'captcha') return new SiteError('captcha', msg('kind.captcha'));
    const text = await page.innerText('body').catch(() => '');
    // 控件没初始化时，提交只带了一个字段，站点提示必填项为空。这不是资料错误
    if (/Enter all mandatory fields/i.test(text)) {
      return new SiteError('widgets_missing', msg('err.mandatory'));
    }
    if (/booking (number|details).*(not|incorrect|invalid)|no booking|not (been )?found|could not (find|locate|match|retrieve)/i.test(text)) {
      return new SiteError('bad_credentials', msg('kind.bad_credentials'));
    }
    // 不知道网站到底怎么了：按访问失败处理，下一轮用全新会话重试，不让教练每次都来手动恢复
    return new SiteError('timeout', msg('err.login_unknown_retry'));
  }

  /** 翻到包含 date 的那一周（站点一次显示一周） */
  private async goToWeek(page: Page, date: LocalDate): Promise<void> {
    const want = mondayOf(date);
    for (let i = 0; i < 20; i++) {
      const cur = parseSiteDate(await page.locator('#formTableWeekStarting').inputValue());
      if (cur === want) return;
      await this.clickAndLoad(page, cur < want ? '#nextWeekButton' : '#prevWeekButton');
      await this.expectKind(page, 'choose_time');
    }
    throw new SiteError('unknown_page', msg('err.week_not_found', { date }));
  }

  private async clickAndLoad(page: Page, selector: string): Promise<void> {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}),
      page.locator(selector).first().click(),
    ]);
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    // 以前固定等 1.5 秒；现在由 expectKind / waitKind 等页面真的变过来
    await page.waitForTimeout(300);
  }

  private async go(page: Page, url: string): Promise<void> {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      if (res && res.status() === 403) throw new SiteError('blocked', msg('err.http_403'));
    } catch (err) {
      if (err instanceof SiteError) throw err;
      const text = err instanceof Error ? err.message : String(err);
      if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/.test(text)) throw new SiteError('blocked', msg('err.conn_reset', { detail: text.split('\n')[0]! }));
      throw new SiteError('timeout', msg('err.open_failed', { detail: text.split('\n')[0]! }));
    }
  }

  /** 每半秒看一次页面，直到 ok 或被拦/验证码或超时，返回最后看到的页面 */
  private async waitKind(page: Page, ok: (k: PageKind) => boolean, ms: number): Promise<PageKind> {
    const end = Date.now() + ms;
    for (;;) {
      const kind = await this.currentKind(page);
      if (ok(kind) || kind === 'blocked' || kind === 'captcha' || Date.now() >= end) return kind;
      await page.waitForTimeout(500);
    }
  }

  private async currentKind(page: Page): Promise<PageKind> {
    const text = await page.innerText('body').catch(() => '');
    return detectPage(text, page.url());
  }

  /** 等页面变成 want。页面跳转后正文要一会儿才出来，所以要等，最多 15 秒 */
  private async expectKind(page: Page, want: PageKind): Promise<void> {
    const kind = await this.waitKind(page, (k) => k === want, 15_000);
    if (kind === want) return;
    if (kind === 'blocked') throw new SiteError('blocked', msg('kind.blocked'));
    if (kind === 'captcha') throw new SiteError('captcha', msg('kind.captcha'));
    throw new SiteError('unknown_page', msg('err.unexpected_page', { want, got: kind }));
  }

  private async assertNotBlocked(page: Page): Promise<void> {
    const kind = await this.currentKind(page);
    if (kind === 'blocked') throw new SiteError('blocked', msg('kind.blocked'));
    if (kind === 'captcha') throw new SiteError('captcha', msg('kind.captcha'));
  }

  private async readSummary(page: Page): Promise<BookingInfo> {
    try {
      const b = parseBookingDetails(await page.innerText('body'));
      this.current = b;
      this.currentAt = (this.opts.now ?? Date.now)();
      return b;
    } catch (err) {
      throw new SiteError('unknown_page', msg('err.read_summary', { detail: errorText(err) }));
    }
  }

  /** 从选考点、选时间、确认页回到"查看预约"页：点页面上的退出/返回按钮 */
  private async tryReturnToMain(page: Page): Promise<boolean> {
    // 要点页面了：浏览器里显示的可能不是站点现在的状态，先载入站点现在的页面
    const p = this.parked;
    this.parked = null;
    if (p && !p.domFresh) await this.go(page, p.url).catch(() => {});
    const kind = await this.waitKind(page, (k) => k !== 'unknown', 5_000);
    if (kind === 'main') return true;
    if (kind === 'blocked') throw new SiteError('blocked', msg('kind.blocked'));
    if (kind === 'captcha') throw new SiteError('captcha', msg('kind.captcha'));
    if (kind !== 'choose_location' && kind !== 'choose_time' && kind !== 'confirm') return false;
    this.pending = null;
    for (let i = 0; i < 4; i++) {
      const back = page.locator('#backButton');
      if ((await back.count()) === 0 || !(await back.first().isVisible().catch(() => false))) break;
      await this.clickAndLoad(page, '#backButton');
      const after = await this.waitKind(page, (k) => k === 'main', 8_000);
      if (after === 'main') return true;
      if (after === 'blocked') throw new SiteError('blocked', msg('kind.blocked'));
      if (after === 'captcha') throw new SiteError('captcha', msg('kind.captcha'));
      break;
    }
    return (await this.currentKind(page)) === 'main';
  }
}
