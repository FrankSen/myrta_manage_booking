import type { Page } from 'playwright-core';
import { addDays, mondayOf, weekdayKey, parseSiteDate } from '../domain/time.ts';
import type { BookingInfo, LocalDate, Slot } from '../domain/types.ts';
import { launchBrowser, type BrowserHandle } from './browser.ts';
import { SiteError } from './errors.ts';
import { detectPage, hasNoTimeslotsMessage, parseBookingDetails, parseTimeslots, type PageKind } from './parse.ts';
import type { SiteSession } from './session.ts';

const HOME = 'https://www.myrta.com/';
const NAV_TIMEOUT = 40_000;

export interface FlowOptions {
  profileDir: string;
  /** 为 true 时 finish() 才会真正点 Finish。第一次真实改约验证之前不要打开 */
  allowFinish: boolean;
  /** 测试时替换，默认真实启动浏览器 */
  launch?: (profileDir: string) => Promise<BrowserHandle>;
}

/** 每个学员一个会话：一个独立的浏览器窗口，登录后复用 */
export class BrowserSession implements SiteSession {
  private readonly opts: FlowOptions;
  private handle: BrowserHandle | null = null;
  private loggedIn = false;
  /** 选定考位、停在确认页时，记录所选考位，防止 finish() 在没选位时被调用 */
  private pending: Slot | null = null;

  constructor(opts: FlowOptions) {
    this.opts = opts;
  }

  private async page(): Promise<Page> {
    if (!this.handle) this.handle = await (this.opts.launch ?? launchBrowser)(this.opts.profileDir);
    return this.handle.page;
  }

  async login(bookingId: string, surname: string): Promise<BookingInfo> {
    const page = await this.page();
    // 会话还有效：直接回到"查看预约"页，不用重新登录
    if (this.loggedIn) {
      const kind = await this.currentKind(page);
      if (kind === 'main') return this.readSummary(page);
      if (await this.tryReturnToMain(page)) return this.readSummary(page);
      this.loggedIn = false;
    }

    await this.go(page, HOME);
    await this.assertNotBlocked(page);
    const href = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a')).find((x) => /^\s*Manage booking\s*$/i.test(x.textContent ?? ''));
      return a ? (a as HTMLAnchorElement).href : null;
    });
    if (!href) throw new SiteError('unknown_page', '首页上找不到 "Manage booking" 链接');
    // 直接点这个链接会超时，取出地址再跳转
    await this.go(page, href);
    await this.assertNotBlocked(page);

    const idBox = page.locator('#widget_input_bookingId');
    const nameBox = page.locator('#widget_input_familyName');
    try {
      await idBox.waitFor({ state: 'visible', timeout: 20_000 });
    } catch {
      throw new SiteError('widgets_missing', '登录页的输入框没有出现（页面控件没有初始化）');
    }
    // 逐字输入，像真人一样；整体粘贴有时不触发控件的校验
    await idBox.click();
    await page.keyboard.type(bookingId, { delay: 90 });
    await nameBox.click();
    await page.keyboard.type(surname, { delay: 90 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    await page.locator('#searchBookingCriteria').getByRole('button', { name: /continue/i }).click();

    try {
      await page.waitForURL(/tbs-change-main/, { timeout: 30_000 });
    } catch {
      throw await this.explainLoginFailure(page);
    }
    await page.waitForLoadState('load');
    this.loggedIn = true;
    return this.readSummary(page);
  }

  async listSlots(centreId: number, dateFrom: LocalDate, dateTo: LocalDate): Promise<Slot[]> {
    const page = await this.page();
    await this.openChooseTime(page, centreId, dateFrom);

    const result: Slot[] = [];
    const seen = new Set<string>();
    // 站点一次显示一周，一周一周往后翻，直到超过结束日期
    for (let guard = 0; guard < 20; guard++) {
      const html = await page.content();
      if (hasNoTimeslotsMessage(await page.innerText('body'))) break;
      const weekStart = parseSiteDate(await page.locator('#formTableWeekStarting').inputValue());
      for (const s of parseTimeslots(html)) {
        if (!s.available || s.date < dateFrom || s.date > dateTo) continue;
        const key = `${s.date} ${s.time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ centreId, date: s.date, time: s.time });
      }
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

    const id = `#rms_${weekdayKey(slot.date)}_${slot.time.replace(':', '').replace(/^0/, '')}`;
    const cell = page.locator(`${id} a`);
    if ((await cell.count()) === 0 || !(await cell.first().getAttribute('class'))?.includes('available')) {
      throw new SiteError('unknown_page', `考位 ${slot.date} ${slot.time} 现在不可约`);
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
      throw new SiteError('unknown_page', '提交功能尚未启用：第一次真实改约验证之前，不会点击 Finish');
    }
    if (!this.pending) throw new SiteError('unknown_page', '还没有选定考位，不能提交');
    // 真正的提交动作和完成页的识别，要等第一次真实改约时才能确认，见实现计划任务 10
    throw new SiteError('unknown_page', '提交流程还没有验证过，暂不支持');
  }

  async readCurrent(): Promise<BookingInfo> {
    const page = await this.page();
    if (!(await this.tryReturnToMain(page))) throw new SiteError('unknown_page', '无法回到"查看预约"页');
    return this.readSummary(page);
  }

  async close(): Promise<void> {
    this.loggedIn = false;
    this.pending = null;
    const h = this.handle;
    this.handle = null;
    await h?.close();
  }

  // ---- 内部 ----

  /** 从"查看预约"页出发：选考点页 → 选时间页。期望日期设为 from，直接定位到那一周 */
  private async openChooseTime(page: Page, centreId: number, from: LocalDate): Promise<void> {
    if (!(await this.tryReturnToMain(page))) throw new SiteError('unknown_page', '无法回到"查看预约"页');
    await page.getByRole('link', { name: /change location/i }).first().click();
    await page.waitForLoadState('load');
    await this.expectKind(page, 'choose_location');

    const [y, m, d] = from.split('-') as [string, string, string];
    await page.evaluate((v) => {
      const w = (window as unknown as { dijit?: { byId(id: string): { set(k: string, v: string): void } | undefined } }).dijit?.byId('rms_batDateSel');
      w?.set('displayedValue', v);
    }, `${d}/${m}/${y}`);
    await page.locator('#rms_batLocLocSel').check();
    await page.waitForTimeout(600);
    await page.selectOption('select[name=locationSelect]', String(centreId));
    await page.waitForTimeout(800);
    await this.clickAndLoad(page, '#rms_testGroupWrapper >> role=button[name=/next/i]');
    await this.expectKind(page, 'choose_time');
  }

  /** 提交登录后没有进入"查看预约"页，判断是什么原因 */
  private async explainLoginFailure(page: Page): Promise<SiteError> {
    const kind = await this.currentKind(page);
    if (kind === 'blocked') return new SiteError('blocked', '站点暂时拒绝访问');
    if (kind === 'captcha') return new SiteError('captcha', '站点要求验证码');
    const text = await page.innerText('body').catch(() => '');
    // 控件没初始化时，提交只带了一个字段，站点提示必填项为空。这不是资料错误
    if (/Enter all mandatory fields/i.test(text)) {
      return new SiteError('widgets_missing', '提交时提示必填项为空（控件没有初始化）');
    }
    if (/booking (number|details).*(not|incorrect|invalid)|no booking|not (been )?found|could not (find|locate)/i.test(text)) {
      return new SiteError('bad_credentials', 'Booking number 或姓氏不正确');
    }
    return new SiteError('unknown_page', '提交登录后没有进入预约页，也不是已知的错误提示');
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
    throw new SiteError('unknown_page', `翻不到 ${date} 所在的那一周`);
  }

  private async clickAndLoad(page: Page, selector: string): Promise<void> {
    await Promise.all([
      page.waitForLoadState('load', { timeout: NAV_TIMEOUT }).catch(() => {}),
      page.locator(selector).first().click(),
    ]);
    await page.waitForLoadState('load', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  private async go(page: Page, url: string): Promise<void> {
    try {
      const res = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      if (res && res.status() === 403) throw new SiteError('blocked', '站点返回 403');
    } catch (err) {
      if (err instanceof SiteError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/.test(msg)) throw new SiteError('blocked', `连接被站点断开：${msg.split('\n')[0]}`);
      throw new SiteError('timeout', `打开页面失败：${msg.split('\n')[0]}`);
    }
  }

  private async currentKind(page: Page): Promise<PageKind> {
    const text = await page.innerText('body').catch(() => '');
    return detectPage(text, page.url());
  }

  private async expectKind(page: Page, want: PageKind): Promise<void> {
    const kind = await this.currentKind(page);
    if (kind === want) return;
    if (kind === 'blocked') throw new SiteError('blocked', '站点暂时拒绝访问');
    if (kind === 'captcha') throw new SiteError('captcha', '站点要求验证码');
    throw new SiteError('unknown_page', `期望页面 ${want}，实际是 ${kind}`);
  }

  private async assertNotBlocked(page: Page): Promise<void> {
    const kind = await this.currentKind(page);
    if (kind === 'blocked') throw new SiteError('blocked', '站点暂时拒绝访问');
    if (kind === 'captcha') throw new SiteError('captcha', '站点要求验证码');
  }

  private async readSummary(page: Page): Promise<BookingInfo> {
    try {
      return parseBookingDetails(await page.innerText('body'));
    } catch (err) {
      throw new SiteError('unknown_page', `读不出当前预约：${err instanceof Error ? err.message : String(err)}`);
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
