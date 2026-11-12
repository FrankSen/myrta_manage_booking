import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Centre } from '../domain/types.ts';
import type { NotifyEvent } from '../engine/checker.ts';
import type { Service } from '../engine/service.ts';
import { describeEvent, type UiMessage } from '../notify/notifier.ts';
import type { BookingInfo } from '../domain/types.ts';
import type { Repo, Student } from '../storage/repo.ts';
import { INTERVAL_CHOICES_MIN, INTERVAL_HELP } from '../config/interval.ts';
import { DEFAULT_TOLERANCE, refreshDeadline } from '../domain/matcher.ts';
import { ValidationError, parseInterval, parseNewStudent, parseTarget } from './validate.ts';

export interface UiDeps {
  repo: Repo;
  service: Service;
  centreList: readonly Centre[];
  /** 新增学员时登录一次读取当前预约。失败抛错，错误信息会返回给教练 */
  fetchCurrent(bookingId: string, surname: string): Promise<BookingInfo>;
  autoRebookEnabled: boolean;
  /** 日期容差，算"还能刷新到什么时候"用，和引擎一致 */
  maxDateDays?: number;
  now(): number;
  /** 用系统默认浏览器打开 myrta.com，让教练手动改约。测试时替换 */
  openSite?: () => void;
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
export function publicStudent(s: Student, service?: Pick<Service, 'progress' | 'intervalFor'>, maxDateDays = DEFAULT_TOLERANCE.maxDateDays) {
  return {
    rounds: s.rounds,
    lastRoundAt: s.lastRoundAt,
    intervalMs: s.intervalMs,
    effectiveIntervalMs: service?.intervalFor(s.id) ?? null,
    progress: service?.progress(s.id) ?? null,
    /** 最晚能刷新到什么时候，过了就自动停止 */
    deadline: refreshDeadline(s.current, s.target, maxDateDays),
    id: s.id,
    label: s.label,
    bookingIdTail: s.bookingId.slice(-3),
    current: s.current,
    target: s.target,
    status: s.status,
    statusNote: s.statusNote,
  };
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
    if (size > 64 * 1024) throw new ValidationError('请求太大');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('请求内容不是有效的 JSON');
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
      if (!/^[\w.-]+$/.test(name)) return send(res, 404, { error: '没有这个页面' });
      try {
        const body = readFileSync(new URL(name, PUBLIC_DIR));
        const ext = name.slice(name.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch {
        send(res, 404, { error: '没有这个页面' });
      }
      return;
    }

    const given = req.headers['x-token'] as string | undefined ?? url.searchParams.get('t');
    if (!tokenOk(given, token)) return send(res, 401, { error: '未授权' });

    const path = url.pathname;
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/state') {
      return send(res, 200, {
        centres: deps.centreList.map((c) => ({ id: c.id, name: c.name, suburb: c.suburb, postcode: c.postcode })),
        autoRebookEnabled: deps.autoRebookEnabled,
        messages: recentMessages,
        intervalMs: deps.service.globalInterval(),
        intervalChoicesMin: INTERVAL_CHOICES_MIN,
        intervalHelp: INTERVAL_HELP,
        now: deps.now(),
      });
    }
    if (method === 'GET' && path === '/api/students') {
      return send(res, 200, { now: deps.now(), students: deps.repo.listStudents().map((x) => publicStudent(x, deps.service, deps.maxDateDays)) });
    }
    if (method === 'POST' && path === '/api/students') {
      const input = parseNewStudent(await readJson(req));
      let current: BookingInfo;
      try {
        current = await deps.fetchCurrent(input.bookingId, input.surname);
      } catch (err) {
        return send(res, 422, { error: `无法读取这个预约：${err instanceof Error ? err.message : String(err)}` });
      }
      const centre = deps.centreList.find((c) => c.name.toLowerCase() === current.centreName.toLowerCase());
      const id = deps.repo.addStudent({
        ...input,
        current,
        target: { centreIds: centre ? [centre.id] : [], dateFrom: current.date, dateTo: current.date, timeFrom: '08:00', timeTo: '17:00' },
      });
      return send(res, 201, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays));
    }
    if ((m = /^\/api\/students\/(\d+)\/target$/.exec(path)) && method === 'PUT') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: '没有这个学员' });
      deps.repo.updateTarget(id, parseTarget(await readJson(req), known));
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays));
    }
    if ((m = /^\/api\/students\/(\d+)\/(start|pause)$/.exec(path)) && method === 'POST') {
      const id = Number(m[1]);
      const s = deps.repo.getStudent(id);
      if (!s) return send(res, 404, { error: '没有这个学员' });
      if (m[2] === 'start') {
        if (s.target.centreIds.length === 0) return send(res, 400, { error: '请先设置目标考点' });
        if (!deps.service.startStudent(id)) return send(res, 409, { error: '无法开始：已达到同时刷新的学员上限，或该学员已完成' });
      } else {
        deps.service.pauseStudent(id);
      }
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays));
    }
    if ((m = /^\/api\/students\/(\d+)$/.exec(path)) && method === 'DELETE') {
      const id = Number(m[1]);
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: '没有这个学员' });
      deps.service.pauseStudent(id);
      deps.repo.deleteStudent(id);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/offers') {
      return send(res, 200, deps.repo.listOffers().filter((o) => o.state === 'open'));
    }
    if ((m = /^\/api\/offers\/(\d+)\/(accept|dismiss)$/.exec(path)) && method === 'POST') {
      const id = Number(m[1]);
      if (!deps.repo.getOffer(id)) return send(res, 404, { error: '没有这个待确认考位' });
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
      if (!deps.repo.getStudent(id)) return send(res, 404, { error: '没有这个学员' });
      deps.service.setStudentInterval(id, parseInterval(await readJson(req), true));
      return send(res, 200, publicStudent(deps.repo.getStudent(id)!, deps.service, deps.maxDateDays));
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
    send(res, 404, { error: '没有这个接口' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      send(res, 500, { error: '程序内部出错' });
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
