import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Centre } from '../domain/types.ts';
import type { NotifyEvent } from '../engine/checker.ts';
import type { Service } from '../engine/service.ts';
import { describeEvent, type UiMessage } from '../notify/notifier.ts';
import { isFeishuWebhook } from '../notify/feishu.ts';
import type { BookingInfo } from '../domain/types.ts';
import type { Repo, Student } from '../storage/repo.ts';
import type { LicenseState } from '../license/license.ts';
import { INTERVAL_CHOICES_MS, INTERVAL_HELP } from '../config/interval.ts';
import { errorText, isLang, msg, type Lang, type Text } from '../i18n.ts';
import { DEFAULT_TOLERANCE, refreshDeadline } from '../domain/matcher.ts';
import { MAX_CENTRES, ValidationError, parseInterval, parseNewStudent, parseTarget } from './validate.ts';

export interface UiDeps {
  repo: Repo;
  service: Service;
  centreList: readonly Centre[];
  /** 新增学员时登录一次读取当前预约。失败抛错，错误信息会返回给教练 */
  fetchCurrent(bookingId: string, surname: string): Promise<BookingInfo>;
  /** 学员建好后，把刚才读取用的浏览器资料目录交给这个学员继续用 */
  adoptProfile?: (studentId: number, bookingId: string) => void;
  /** 中断添加学员时正在进行的读取 */
  cancelFetch?: () => void;
  autoRebookEnabled: boolean;
  /** 站点会话能不能真正点 Finish。不能时不允许打开自动改约。默认能 */
  finishAvailable?: boolean;
  /** 自动改约开关改了之后保存。没有时只在本次运行有效 */
  saveAutoRebook?: (enabled: boolean) => void;
  /** 日期容差，算"还能刷新到什么时候"用，和引擎一致 */
  maxDateDays?: number;
  now(): number;
  /** 授权。没有时不检查（测试用） */
  license?: { state(): LicenseState; import(text: string): LicenseState };
  /** 当前界面语言和保存方法。没有时固定中文、不保存 */
  language?: { get(): Lang; set(lang: Lang): void };
  /** 用系统默认浏览器打开 myrta.com，让教练手动改约。测试时替换 */
  openSite?: () => void;
  /** 重要消息外推（飞书等）。没有时不外推 */
  pushMessage?: (m: UiMessage) => void;
  /** 飞书 Webhook 地址的读取和保存。没有时界面不显示该设置 */
  feishu?: { get(): string; set(url: string): void };
}

const SITE = 'https://www.myrta.com/';

/** 用系统默认浏览器打开网址。不用界面窗口的 Chrome：它是中文环境，站点在中文环境下登录控件不工作 */
export function defaultOpenSite(): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', SITE]] : process.platform === 'darwin' ? ['open', [SITE]] : ['xdg-open', [SITE]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export interface UiServer {
  token: string;
  port: number;
  url: string;
  /** 把引擎事件推给所有已连接的界面 */
  publish(event: NotifyEvent): void;
  close(): Promise<void>;
}

const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

/** 对外只给 Booking number 的末 3 位，姓氏不返回 */
export function publicStudent(s: Student, service?: Pick<Service, 'progress' | 'intervalFor' | 'expectedCycle'> & Partial<Pick<Service, 'holdInfo'>>, maxDateDays = DEFAULT_TOLERANCE.maxDateDays, repo?: Pick<Repo, 'handoverFrom'>) {
  return {
    /** 预计实际多久刷新一次（排队后），学员多、考点多时比设定间隔慢 */
    expectedCycleMs: service && s.target.centreIds.length > 0 ? service.expectedCycle(s.id) : null,
    rounds: s.rounds,
    lastRoundAt: s.lastRoundAt,
    intervalMs: s.intervalMs,
    effectiveIntervalMs: service?.intervalFor(s.id) ?? null,
    progress: service?.progress(s.id) ?? null,
    /** 停在确认页等教练：所选考位和保留到什么时候 */
    hold: service?.holdInfo?.(s.id) ?? null,
    /** 最晚能刷新到什么时候，过了就自动停止 */
    deadline: refreshDeadline(s.current, s.target, maxDateDays),
    id: s.id,
    label: s.label,
    bookingIdTail: s.bookingId.slice(-3),
    current: s.current,
    target: s.target,
    status: s.status,
    statusNote: s.statusNote,
    /** 让位：让给哪个学员（我改约后原考位由他抢） */
    handoverTo: s.handoverTo,
    /** 让位：接哪个学员的考位（目标固定为他的考位，不能改） */
    handoverFrom: repo?.handoverFrom(s.id)?.id ?? null,
  };
}

const licenseText = (reason: Exclude<LicenseState, { ok: true }>['reason']) => msg(`license.${reason}`);

function publicLicense(s: LicenseState) {
  return s.ok
    ? { ok: true, name: s.name, until: s.until }
    : { ok: false, reason: s.reason, message: licenseText(s.reason), name: s.name ?? null, until: s.until ?? null };
}

function tokenOk(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new ValidationError(msg('api.too_big'));
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError(msg('api.bad_json'));
  }
}

export async function startUiServer(deps: UiDeps, opts: { port?: number; token?: string } = {}): Promise<UiServer> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const known = new Set(deps.centreList.map((c) => c.id));
  const centresById = new Map(deps.centreList.map((c) => [c.id, c]));
  const clients = new Set<ServerResponse>();
  const recentMessages: UiMessage[] = [];

  const publish = (event: NotifyEvent) => {
    const msg = describeEvent(event, deps.repo, centresById);
    recentMessages.unshift(msg);
    recentMessages.length = Math.min(recentMessages.length, 50);
    deps.pushMessage?.(msg);
    const data = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) c.write(data);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    // 本地页面资源：不需要令牌就能取静态文件，但里面没有数据；数据接口都要令牌
    if (method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(name)) return send(res, 404, { error: msg('api.not_found_page') });
      try {
        const body = readFileSync(new URL(name, PUBLIC_DIR));
        const ext = name.slice(name.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch {
        send(res, 404, { error: msg('api.not_found_page') });
      }
      return;
    }

    const given = req.headers['x-token'] as string | undefined ?? url.searchParams.get('t');
    if (!tokenOk(given, token)) return send(res, 401, { error: msg('api.unauthorized') });

    const path = url.pathname;
    let m: RegExpExecArray | null;

    const licenseState = (): LicenseState => deps.license?.state() ?? { ok: true, name: '', until: '', expiresAt: Infinity };
    if (method === 'GET' && path === '/api/license') return send(res, 200, publicLicense(licenseState()));
    if (method === 'POST' && path === '/api/license') {
      const body = (await readJson(req)) as { text?: unknown };
      if (!deps.license) return send(res, 400, { error: msg('api.no_license_needed') });
      if (typeof body.text !== 'string') throw new ValidationError(msg('api.choose_license'));
      const s = deps.license.import(body.text);
      return send(res, s.ok ? 200 : 400, s.ok ? publicLicense(s) : { error: licenseText(s.reason), license: publicLicense(s) });
    }
    // 会访问站点的操作，授权无效时一律拒绝；查看类接口照常可用
    const needsLicense = method !== 'GET' && (/^\/api\/students(\/\d+\/start)?$/.test(path) && method === 'POST' || /^\/api\/offers\/\d+\/accept$/.test(path) || /^\/api\/students\/\d+\/handover$/.test(path) && method === 'PUT');
    if (needsLicense) {
      const s = licenseState();
      if (!s.ok) return send(res, 403, { error: licenseText(s.reason), license: publicLicense(s) });
    }

    if (method === 'GET' && path === '/api/state') {
      return send(res, 200, {
        license: publicLicense(licenseState()),
        centres: deps.centreList.map((c) => ({ id: c.id, name: c.name, suburb: c.suburb, postcode: c.postcode })),
        autoRebookEnabled: deps.service.autoRebookEnabled?.() ?? deps.autoRebookEnabled,
        finishAvailable: deps.finishAvailable !== false,
        messages: recentMessages,
        intervalMs: deps.service.globalInterval(),
        intervalChoicesMs: INTERVAL_CHOICES_MS,
        maxCentres: MAX_CENTRES,
        intervalHelp: INTERVAL_HELP,
        feishuWebhook: deps.feishu?.get() ?? null,
        language: deps.language?.get() ?? 'zh',
        now: deps.now(),
      });
    }
    if (method === 'GET' && path === '/api/students') {
      return send(res, 200, { now: deps.now(), students: deps.repo.listStudents().map((x) => publicStudent(x, deps.service, deps.maxDateDays, deps.repo)) });
    }
    if (method === 'POST' && path === '/api/students/cancel-read') {
      deps.cancelFetch?.();
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/students') {
      const input = parseNewStudent(await readJson(req));
      let current: BookingInfo;
      try {
        current = await deps.fetchCurrent(input.bookingId, input.surname);
      } catch (err) {
        return send(res, 422, { error: msg('api.read_booking', { detail: errorText(err) }) });
      }
      const centre = deps.centreList.find((c) => c.name.toLowerCase() === current.centreName.toLowerCase());
      const id = deps.repo.addStudent({
        ...input,
        current,
        target: { centreIds: centre ? [centre.id] : [], dateFrom: current.date, dateTo: current.date, timeFrom: '08:00', timeTo: '17:00' },
      });
      deps.adoptProfile?.(id, input.bookingId);
      return send(res, 201, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays, deps.repo));
    }
    if ((m = /^\/api\/students\/(\d+)\/target$/.exec(path)) && method === 'PUT') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: msg('api.no_student') });
      // 接让位的学员，目标固定为对方的考位，先解除让位才能改
      if (deps.repo.handoverFrom(id)) return send(res, 409, { error: msg('api.handover_target_locked') });
      deps.repo.updateTarget(id, parseTarget(await readJson(req), known));
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays, deps.repo));
    }
    if ((m = /^\/api\/students\/(\d+)\/(start|pause)$/.exec(path)) && method === 'POST') {
      const id = Number(m[1]);
      const s = deps.repo.getStudent(id);
      if (!s) return send(res, 404, { error: msg('api.no_student') });
      if (m[2] === 'start') {
        if (s.target.centreIds.length === 0) return send(res, 400, { error: msg('api.need_centre') });
        if (!deps.service.startStudent(id)) return send(res, 409, { error: msg('api.cant_start') });
      } else {
        deps.service.pauseStudent(id);
      }
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays, deps.repo));
    }
    if ((m = /^\/api\/students\/(\d+)\/handover$/.exec(path)) && method === 'PUT') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: msg('api.no_student') });
      const to = ((await readJson(req)) as { to?: unknown }).to;
      if (to !== null && !(typeof to === 'number' && Number.isInteger(to))) throw new ValidationError(msg('api.handover_bad'));
      const r = deps.service.setHandover(id, to);
      if (r !== 'ok') return send(res, r === 'no_student' ? 404 : 409, { error: msg(`api.handover_${r}`), result: r });
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays, deps.repo));
    }
    if ((m = /^\/api\/students\/(\d+)\/check-now$/.exec(path)) && method === 'POST') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: msg('api.no_student') });
      if (!deps.service.checkNow(id)) return send(res, 409, { error: msg('api.not_running') });
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays, deps.repo));
    }
    if ((m = /^\/api\/students\/(\d+)\/hold\/(abandon|submitted|reveal)$/.exec(path)) && method === 'POST') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: msg('api.no_student') });
      if (m[2] === 'reveal') return send(res, 200, { result: (await deps.service.revealHold(id)) ? 'ok' : 'not_held' });
      return send(res, 200, { result: await deps.service.endHold(id, m[2] as 'abandon' | 'submitted') });
    }
    if ((m = /^\/api\/students\/(\d+)$/.exec(path)) && method === 'DELETE') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: msg('api.no_student') });
      deps.service.pauseStudent(id);
      deps.repo.deleteStudent(id);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/offers') {
      return send(res, 200, deps.repo.listOffers().filter((o) => o.state === 'open'));
    }
    if ((m = /^\/api\/offers\/(\d+)\/(accept|dismiss)$/.exec(path)) && method === 'POST') {
      const id = Number(m[1]);
      if (!deps.repo.getOffer(id)) return send(res, 404, { error: msg('api.no_offer') });
      if (m[2] === 'dismiss') {
        deps.service.dismissOffer(id);
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { result: await deps.service.acceptOffer(id) });
    }
    if (method === 'PUT' && path === '/api/settings/interval') {
      const ms = parseInterval(await readJson(req), false);
      deps.service.setGlobalInterval(ms!);
      return send(res, 200, { intervalMs: ms });
    }
    if ((m = /^\/api\/students\/(\d+)\/interval$/.exec(path)) && method === 'PUT') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: msg('api.no_student') });
      deps.service.setStudentInterval(id, parseInterval(await readJson(req), true));
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays, deps.repo));
    }
    if (method === 'PUT' && path === '/api/settings/language') {
      const lang = ((await readJson(req)) as { language?: unknown }).language;
      if (!isLang(lang)) throw new ValidationError(msg('api.bad_lang'));
      deps.language?.set(lang);
      return send(res, 200, { language: lang });
    }
    if (method === 'PUT' && path === '/api/settings/auto-rebook') {
      const enabled = ((await readJson(req)) as { enabled?: unknown }).enabled;
      if (typeof enabled !== 'boolean') throw new ValidationError(msg('api.auto_rebook_bad'));
      if (enabled && deps.finishAvailable === false) return send(res, 409, { error: msg('api.auto_rebook_unavailable') });
      deps.service.setAutoRebook(enabled);
      deps.saveAutoRebook?.(enabled);
      return send(res, 200, { autoRebookEnabled: enabled });
    }
    if (method === 'PUT' && path === '/api/settings/feishu') {
      if (!deps.feishu) return send(res, 404, { error: msg('api.no_student') });
      const raw = ((await readJson(req)) as { webhook?: unknown }).webhook;
      const url = typeof raw === 'string' ? raw.trim() : '';
      // 空串表示关闭推送；非空必须是飞书官方 Webhook 地址
      if (url && !isFeishuWebhook(url)) return send(res, 400, { error: msg('v.feishu_url') });
      deps.feishu.set(url);
      return send(res, 200, { feishuWebhook: url });
    }
    if (method === 'POST' && path === '/api/open-site') {
      (deps.openSite ?? defaultOpenSite)();
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/logs') {
      return send(res, 200, deps.repo.recentLogs(100));
    }
    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, { error: msg('api.no_api') });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof ValidationError) return send(res, 400, { error: err.text });
      send(res, 500, { error: msg('api.internal') });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    token,
    port,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    publish,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
