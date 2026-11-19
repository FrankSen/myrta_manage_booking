import type { Page } from 'playwright-core';
import { addDays, mondayOf, parseSiteDate, slotCellTime, weekdayKey } from '../domain/time.ts';
import type { BookingInfo, LocalDate, Slot } from '../domain/types.ts';
import { launchBrowser, setWindowState, type BrowserHandle } from './browser.ts';
import { SiteError } from './errors.ts';
import { errorText, msg } from '../i18n.ts';
import { detectPage, freshText, hasNoTimeslotsMessage, loginProblem, hasTimeslotsData, parseBookingDetails, parseTimeslots, type PageKind } from './parse.ts';
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
 * 确认页的 Finish 按钮。**没在真实网站上见过**，先按 id 找，找不到按按钮文字找。
 * 第一次真实提交时核对（见 test/helpers/mock-myrta.ts 顶部说明）
 */
const FINISH_BUTTON = '#finishButton, button:has-text("Finish"), input[type=submit][value="Finish" i]';

export interface FlowOptions {
  profileDir: string;
  /** 为 true 时 finish() 才会真正点 Finish。第一次真实改约验证之前不要打开 */
  allowFinish: boolean;
  /** 网站首页，默认真实的 myrta.com。测试时指向本地假网站 */
  home?: string;
  /** 测试时替换，默认真实启动浏览器 */
  launch?: (profileDir: string) => Promise<BrowserHandle>;
}

/** 每个学员一个会话：一个独立的浏览器窗口，登录后复用 */
export class BrowserSession implements SiteSession {
  private readonly opts: FlowOptions;
  private handle: BrowserHandle | null = null;
  private loggedIn = false;
  /** 最近一次登录用的资料：提交后停在完成页、回不到预约页时，重新登录读取预约 */
  private creds: { bookingId: string; surname: string } | null = null;
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
    await page.locator('#searchBookingCriteria').getByRole('button', { name: /continue/i }).click();
    await this.waitForMain(page, before);
    await page.waitForLoadState('domcontentloaded');
    this.loggedIn = true;
    return this.readSummary(page);
  }

  async listSlots(centreId: number, dateFrom: LocalDate, dateTo: LocalDate): Promise<Slot[]> {
    const page = await this.page();
    await this.openChooseTime(page, centreId, dateFrom);

    const result: Slot[] = [];
    const seen = new Set<string>();
    this.lastListWeeks = [];
    // 站点一次显示一周，一周一周往后翻，直到超过结束日期
    for (let guard = 0; guard < 20; guard++) {
      const html = await this.timeslotsHtml(page);
      if (html === null) {
        this.lastListWeeks.push({ weekStart: null, total: 0, available: 0, inRange: 0, noSlotsMessage: true });
        break;
      }
      const weekStart = parseSiteDate(await page.locator('#formTableWeekStarting').inputValue());
      const raw = parseTimeslots(html);
      let inRange = 0;
      for (const s of raw) {
        if (!s.available || s.date < dateFrom || s.date > dateTo) continue;
        inRange++;
        const key = `${s.date} ${s.time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ centreId, date: s.date, time: s.time });
      }
      this.lastListWeeks.push({ weekStart, total: raw.length, available: raw.filter((s) => s.available).length, inRange, noSlotsMessage: false });
      if (addDays(weekStart, 7) > dateTo) break;
      await this.clickAndLoad(page, '#nextWeekButton');
      await this.expectKind(page, 'choose_time');
    }
    return result;
  }

  async reachConfirm(slot: Slot): Promise<BookingInfo> {
    const page = await this.page();
    // listSlots 刚读完某一周，选位前必须在正确的考点和周上
    await this.expectKind(page, 'choose_time');
    await this.goToWeek(page, slot.date);

    const id = `#rms_${weekdayKey(slot.date)}_${slotCellTime(slot.time)}`;
    const cell = page.locator(`${id} a`);
    if ((await cell.count()) === 0 || !(await cell.first().getAttribute('class'))?.includes('available')) {
      throw new SiteError('unknown_page', msg('err.slot_unavailable', { date: slot.date, time: slot.time }));
    }
    await cell.first().click();
    await page.waitForTimeout(800);
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

    // 联系方式用网站上已登记的号码，再勾选条款（2026-11-17 教练：联系方式已经存在网站上）
    const phone = page.locator('#existingPhone');
    if ((await phone.count()) === 0) throw new SiteError('unknown_page', msg('err.finish_no_phone'));
    await phone.first().check();
    const terms = page.locator('#checkTerms');
    if ((await terms.count()) === 0) throw new SiteError('unknown_page', msg('err.finish_no_terms'));
    await terms.first().check();
    await page.waitForTimeout(300);
    const button = page.locator(FINISH_BUTTON);
    if ((await button.count()) === 0) throw new SiteError('unknown_page', msg('err.finish_no_button'));

    // 从这里开始可能已经提交。结果只是页面的说法，调用方必须再用 readCurrent 核实
    const before = await page.innerText('body').catch(() => '');
    this.pending = null;
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}),
      button.first().click(),
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

  async conceal(): Promise<void> {
    if (this.handle && process.env.MYRTA_MINIMIZE !== '0') await setWindowState(this.handle.page, 'minimized');
  }

  async close(): Promise<void> {
    this.loggedIn = false;
    this.pending = null;
    const h = this.handle;
    this.handle = null;
    await h?.close();
  }

  // ---- 内部 ----

  private home(): string {
    return this.opts.home ?? HOME;
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

  /**
   * 取选时间页的 HTML。站点明确说没有考位时返回 null。
   * 两样都没有说明页面还没加载完：等一会儿再看，仍然没有就报错，不能当作"没有考位"
   */
  private async timeslotsHtml(page: Page): Promise<string | null> {
    for (let i = 0; i < 20; i++) {
      const html = await page.content();
      if (hasTimeslotsData(html)) return html;
      if (hasNoTimeslotsMessage(await page.innerText('body').catch(() => ''))) return null;
      await page.waitForTimeout(1000);
    }
    throw new SiteError('unknown_page', msg('err.no_slots_data'));
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
    await page.waitForTimeout(1500);
    await this.expectKind(page, 'choose_location');

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
    if (/booking (number|details).*(not|incorrect|invalid)|no booking|not (been )?found|could not (find|locate)/i.test(text)) {
      return new SiteError('bad_credentials', msg('kind.bad_credentials'));
    }
    return new SiteError('unknown_page', msg('err.login_unknown'));
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
    await page.waitForTimeout(1500);
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

  private async currentKind(page: Page): Promise<PageKind> {
    const text = await page.innerText('body').catch(() => '');
    return detectPage(text, page.url());
  }

  private async expectKind(page: Page, want: PageKind): Promise<void> {
    const kind = await this.currentKind(page);
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
      return parseBookingDetails(await page.innerText('body'));
    } catch (err) {
      throw new SiteError('unknown_page', msg('err.read_summary', { detail: errorText(err) }));
    }
  }

  /** 从选考点、选时间、确认页回到"查看预约"页：点页面上的退出/返回按钮 */
  private async tryReturnToMain(page: Page): Promise<boolean> {
    const kind = await this.currentKind(page);
    if (kind === 'main') return true;
    if (kind !== 'choose_location' && kind !== 'choose_time' && kind !== 'confirm') return false;
    this.pending = null;
    for (let i = 0; i < 4; i++) {
      const back = page.locator('#backButton');
      if ((await back.count()) === 0 || !(await back.first().isVisible().catch(() => false))) break;
      await this.clickAndLoad(page, '#backButton');
      if ((await this.currentKind(page)) === 'main') return true;
    }
    return (await this.currentKind(page)) === 'main';
  }
}
