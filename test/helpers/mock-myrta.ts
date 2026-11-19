// 本地假 myrta 网站：用真实浏览器跑 BrowserSession 的完整流程（含 Finish），不碰真实网站。
//
// Step 1–4（登录、查看预约、选考点、选时间、确认页）的结构照着 2026-11 联网实测过的真实网站做：
// URL（/tbs-change、/tbs-change-main）、"Step N in progress"、元素 id、`var timeslots` 脚本、格子 id 都一致。
// 确认页的联系电话（existingPhone）和条款（#checkTerms）来自实现计划的记录。
// **Finish 按钮（#finishButton）和完成页（"Finish in progress"）是猜的**，真实网站还没见过，
// 第一次真实提交时要核对并按实际修改 flow.ts 和这里。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { addDays, mondayOf, slotCellTime, weekdayKey } from '../../src/domain/time.ts';
import type { LocalDate, LocalTime } from '../../src/domain/types.ts';

export interface MockBooking {
  bookingId: string;
  surname: string;
  centreId: number;
  date: LocalDate;
  time: LocalTime;
}

export interface MockOptions {
  centres: { id: number; name: string }[];
  bookings: MockBooking[];
  /** 各考点可约考位：`YYYY-MM-DD HH:MM` */
  slots?: Record<number, string[]>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const site = (d: LocalDate) => { const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; };
const fromSite = (s: string): LocalDate | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
};
const longDate = (d: LocalDate) => {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return `${DAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}, ${dd} ${MONTHS[m - 1]} ${y}`;
};
const ampm = (t: LocalTime) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export class MockMyrta {
  readonly centres: Map<number, string>;
  readonly bookings = new Map<string, MockBooking>();
  /** centreId → 可约考位集合 `date time` */
  readonly slots = new Map<number, Set<string>>();
  /** 每次成功提交记一条，测试用来核对 */
  readonly finished: { bookingId: string; from: string; to: string }[] = [];
  /** 访问记录（路径），测试用来核对有没有走首页 */
  readonly hits: string[] = [];
  private readonly sessions = new Map<string, string>();
  private server: Server | null = null;
  url = '';

  constructor(opts: MockOptions) {
    this.centres = new Map(opts.centres.map((c) => [c.id, c.name]));
    for (const b of opts.bookings) this.bookings.set(b.bookingId, { ...b });
    for (const [id, list] of Object.entries(opts.slots ?? {})) this.slots.set(Number(id), new Set(list));
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as { port: number }).port;
    this.url = `http://127.0.0.1:${port}/`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  booking(id: string): MockBooking | undefined {
    return this.bookings.get(id);
  }

  isAvailable(centreId: number, date: LocalDate, time: LocalTime): boolean {
    return this.slots.get(centreId)?.has(`${date} ${time}`) ?? false;
  }

  /** 模拟别人在网站上抢走一个考位 */
  take(centreId: number, date: LocalDate, time: LocalTime): void {
    this.slots.get(centreId)?.delete(`${date} ${time}`);
  }

  // ---- 内部 ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    this.hits.push(u.pathname);
    const body = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : new URLSearchParams();
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const who = sid ? this.sessions.get(sid) : undefined;
    const b = who ? this.bookings.get(who) : undefined;

    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (p === '/') return html(res, page('Home', '<p>Welcome to myRTA</p><a href="/tbs-change/?lang=en">Manage booking</a>'));
    if (p === '/tbs-change') {
      if (req.method === 'POST') {
        const found = this.bookings.get(body.get('bookingId') ?? '');
        if (!found || found.surname.toLowerCase() !== (body.get('familyName') ?? '').toLowerCase()) {
          return html(res, loginPage('The details you have entered are incorrect, please check the details and try again or call the Contact Centre on 13 22 13.'));
        }
        const id = randomBytes(8).toString('hex');
        this.sessions.set(id, found.bookingId);
        res.writeHead(303, { Location: '/tbs-change-main/', 'Set-Cookie': `sid=${id}; Path=/; HttpOnly` });
        return void res.end();
      }
      return html(res, loginPage(''));
    }
    if (!p.startsWith('/tbs-change-main')) {
      res.statusCode = 404;
      return void res.end('not found');
    }
    if (!b) {
      res.writeHead(303, { Location: '/tbs-change/' });
      return void res.end();
    }
    const sub = p.slice('/tbs-change-main'.length);
    if (sub === '') return html(res, this.mainPage(b));
    if (sub === '/location') return html(res, this.locationPage());
    if (sub === '/time') {
      const centreId = Number(u.searchParams.get('locationSelect'));
      const week = u.searchParams.get('week') ?? mondayOf(fromSite(u.searchParams.get('preferredDateStr') ?? '') ?? b.date);
      return html(res, this.timePage(centreId, week, ''));
    }
    if (sub === '/confirm') {
      const [centreId, date, time] = [Number(u.searchParams.get('centre')), u.searchParams.get('date') ?? '', u.searchParams.get('time') ?? ''];
      if (!this.isAvailable(centreId, date, time)) return html(res, this.timePage(centreId, mondayOf(date), 'The timeslot you selected is no longer available.'));
      return html(res, this.confirmPage(centreId, date, time, ''));
    }
    if (sub === '/finish' && req.method === 'POST') {
      const [centreId, date, time] = [Number(body.get('centre')), body.get('date') ?? '', body.get('time') ?? ''];
      if (body.get('contact') !== 'existing' || body.get('terms') !== 'on') {
        return html(res, this.confirmPage(centreId, date, time, 'Please select a contact number and accept the terms and conditions.'));
      }
      if (!this.isAvailable(centreId, date, time)) {
        return html(res, this.timePage(centreId, mondayOf(date), 'The timeslot you selected is no longer available.'));
      }
      // 改约：新考位被占，原考位放回网站
      this.take(centreId, date, time);
      const from = `${b.centreId} ${b.date} ${b.time}`;
      const set = this.slots.get(b.centreId) ?? new Set<string>();
      set.add(`${b.date} ${b.time}`);
      this.slots.set(b.centreId, set);
      Object.assign(b, { centreId, date, time });
      this.finished.push({ bookingId: b.bookingId, from, to: `${centreId} ${date} ${time}` });
      return html(res, page('Finish', `<p>Finish in progress</p><h2>Your test booking has been changed</h2>${this.details(b)}<p>A confirmation has been sent to your contact details.</p>`));
    }
    res.statusCode = 404;
    res.end('not found');
  }

  private details(b: { centreId: number; date: LocalDate; time: LocalTime }): string {
    return `<div>Test location: ${esc(this.centres.get(b.centreId) ?? '?')}</div>
<div>Date of test: ${longDate(b.date)}</div>
<div>Time of test: ${ampm(b.time)}</div>`;
  }

  private mainPage(b: MockBooking): string {
    return page('Manage booking', `<p>Step 1 in progress</p>
<h2>Your booking</h2>${this.details(b)}
<button id="changeLocationButton_label" onclick="location.href='/tbs-change-main/location'">Change location</button>`);
  }

  private locationPage(): string {
    const opts = [...this.centres].map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
    return page('Choose location', `<p>Step 2 in progress</p>
<form method="get" action="/tbs-change-main/time">
  <label>Preferred date <input id="widget_rms_batDateSel" autocomplete="off"
    oninput="document.querySelector('input[name=preferredDateStr]').value=this.value"></label>
  <input type="hidden" name="preferredDateStr" value="">
  <label><input type="radio" id="rms_batLocLocSel" name="locType" value="loc"> Choose a location</label>
  <select name="locationSelect"><option value="">--</option>${opts}</select>
  <div id="rms_testGroupWrapper"><button type="submit">Next</button></div>
</form>
<a id="backButton" href="/tbs-change-main/">Back</a>`);
  }

  private timePage(centreId: number, week: LocalDate, message: string): string {
    const list: { startTime: string; availability: boolean; slotNumber: number }[] = [];
    const cells: string[] = [];
    let n = 0;
    for (const key of [...(this.slots.get(centreId) ?? [])].sort()) {
      const [date, time] = key.split(' ') as [LocalDate, LocalTime];
      if (date < week || date >= addDays(week, 7)) continue;
      const [y, m, d] = date.split('-');
      list.push({ startTime: `${d}/${m}/${y} ${time}`, availability: true, slotNumber: ++n });
      const q = `centre=${centreId}&date=${date}&time=${time}`;
      cells.push(`<td id="rms_${weekdayKey(date)}_${slotCellTime(time)}"><a class="available" href="#" onclick="pick('${q}');return false">${time}</a></td>`);
    }
    const nav = (w: LocalDate) => `/tbs-change-main/time?locationSelect=${centreId}&week=${w}`;
    const any = (this.slots.get(centreId)?.size ?? 0) > 0;
    const data = any ? `<script>var timeslots = ${JSON.stringify({ ajaxresult: { slots: { listTimeSlot: list } } })};</script>` : '<p>There are no timeslots available at this location</p>';
    return page('Choose time', `<p>Step 3 in progress</p>
${message ? `<p class="error">${esc(message)}</p>` : ''}
<input id="formTableWeekStarting" value="${site(week)}" readonly>
${data}
<table><tr>${cells.join('')}</tr></table>
<a id="prevWeekButton" href="${nav(addDays(week, -7))}">Previous week</a>
<a id="nextWeekButton" href="${nav(addDays(week, 7))}">Next week</a>
<script>var chosen = null; function pick(q) { chosen = q; }</script>
<button id="nextButton" onclick="if (chosen) location.href='/tbs-change-main/confirm?' + chosen">Next</button>
<a id="backButton" href="/tbs-change-main/">Back</a>`);
  }

  private confirmPage(centreId: number, date: LocalDate, time: LocalTime, message: string): string {
    return page('Confirm', `<p>Step 4 in progress</p>
${message ? `<p class="error">${esc(message)}</p>` : ''}
<h2>Confirm your new booking</h2>${this.details({ centreId, date, time })}
<form method="post" action="/tbs-change-main/finish">
  <input type="hidden" name="centre" value="${centreId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="time" value="${time}">
  <fieldset><legend>Contact number</legend>
    <label><input type="radio" id="existingPhone" name="contact" value="existing"> Use the number we have on file</label>
    <label><input type="radio" id="newPhone" name="contact" value="new"> Enter a new number</label>
  </fieldset>
  <label><input type="checkbox" id="checkTerms" name="terms"> I accept the terms and conditions</label>
  <button id="finishButton" type="submit">Finish</button>
</form>
<a id="backButton" href="/tbs-change-main/">Back</a>`);
  }
}

function loginPage(message: string): string {
  return page('Manage booking', `<h2>Booking number</h2>
${message ? `<p class="error">${esc(message)}</p>` : ''}
<form method="post" action="/tbs-change/" id="searchBookingCriteria">
  <label>Booking number <input id="widget_input_bookingId" name="bookingId" autocomplete="off"></label>
  <label>Family name <input id="widget_input_familyName" name="familyName" autocomplete="off"></label>
  <button type="submit">Continue</button>
</form>`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

function html(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
