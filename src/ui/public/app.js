import { checkTime, describeTime, onFromChange, onToChange, quarterTimes } from './time-options.js';
import { countdown, cycleLabel, estimate, minutesLabel, remaining } from './format.js';

const token = new URLSearchParams(location.search).get('t') || '';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let state = { centres: [], autoRebookEnabled: false };
let centreById = new Map();
let students = [];
/** 服务器时间与本机时间之差，倒计时按服务器时间算 */
let clockSkew = 0;
const serverNow = () => Date.now() + clockSkew;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `出错了（${res.status}）`);
  return data;
}

const STATUS_TEXT = { idle: '未开始', running: '刷新中', pending_confirm: '已找到（未提交）', done: '已改约', stopped: '已停止', paused: '已暂停' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${y}年${m}月${day}日 ${WEEK[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]}`;
};
const fmtStamp = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const centreName = (id) => centreById.get(id)?.name || `考点 ${id}`;

// ---------- 渲染 ----------

function renderStats(list, offers) {
  const n = (st) => list.filter((s) => s.status === st).length;
  const todo = offers.length + n('pending_confirm') + n('paused');
  $('#stats').innerHTML = [
    ['go', n('running'), '刷新中'],
    ['wait', todo, '需要你处理'],
    ['info', n('done'), '已改约'],
    ['', list.length, '学员总数'],
  ].map(([c, v, t]) => `<div class="stat"><span class="light ${c}" ${c ? '' : 'style="background:var(--idle)"'}></span><div><b>${v}</b><br><span>${t}</span></div></div>`).join('');
}

function renderTodo(list, offers) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const items = [];
  for (const o of offers) {
    items.push(`<div class="todo-item" data-offer="${o.id}">
      <div><span class="tag near">接近</span><span class="what">${esc(byId.get(o.studentId)?.label ?? '学员')}：${esc(centreName(o.centreId))} ${esc(fmtDate(o.date))} ${esc(o.time)}</span>
        <div class="hint">${o.notes.map(esc).join('；')}</div></div>
      <div class="actions"><button class="primary" data-act="accept">改到这个时间</button><button data-act="dismiss">忽略</button></div>
    </div>`);
  }
  for (const s of list.filter((x) => x.status === 'pending_confirm')) {
    items.push(`<div class="todo-item" data-id="${s.id}">
      <div><span class="tag found">已找到</span><span class="what">${esc(s.label)}</span>
        <div class="hint">${esc(s.statusNote)}。请到网站手动改约，改好后在这里删除或重新设置目标。</div></div>
      <div class="actions"><button class="warn" data-act="open-site">打开 myrta.com</button><button data-act="start">继续找</button></div>
    </div>`);
  }
  for (const s of list.filter((x) => x.status === 'paused' && x.statusNote && x.statusNote !== '教练手动暂停')) {
    items.push(`<div class="todo-item" data-id="${s.id}">
      <div><span class="tag" style="background:#fbe0dd;color:#a8261c">出错暂停</span><span class="what">${esc(s.label)}</span>
        <div class="hint">${esc(s.statusNote)}</div></div>
      <div class="actions"><button class="primary" data-act="start">重新开始</button></div>
    </div>`);
  }
  $('#todo-box').hidden = items.length === 0;
  $('#todo').innerHTML = items.join('');
}

function studentActions(s) {
  const b = [];
  if (s.status === 'running') b.push('<button data-act="pause">暂停</button>');
  else if (s.status !== 'done') b.push(`<button class="primary" data-act="start">${s.status === 'idle' ? '开始刷新' : '继续刷新'}</button>`);
  if (s.status === 'pending_confirm') b.push('<button class="warn" data-act="open-site">打开 myrta.com</button>');
  b.push('<button data-act="target">设置目标</button>');
  if (s.status !== 'done') b.push('<button data-act="interval">刷新间隔</button>');
  b.push('<button class="danger" data-act="delete">删除</button>');
  return b.join('');
}

/** 刷新进度行：第几轮、下一轮倒计时、正在做什么、还能刷新多久、间隔 */
function runLine(s) {
  const parts = [];
  const left = s.deadline ? s.deadline.at - serverNow() : 0;
  const leftText = remaining(left);
  const interval = `<span>间隔 <b>${minutesLabel(s.effectiveIntervalMs)}</b>${s.intervalMs ? '（单独设置）' : ''}</span>`
    + (s.expectedCycleMs ? `<span title="包括一轮本身的耗时，以及和其他学员排队的时间">预计每 <b>${cycleLabel(s.expectedCycleMs)}</b> 刷新一次</span>` : '');
  if (s.status === 'running') {
    parts.push(`<span>已查 <b>${s.rounds}</b> 轮</span>`);
    const p = s.progress;
    if (p && p.running) {
      parts.push(`<span class="now">● 第 ${s.rounds + 1} 轮进行中${p.phase ? `：${esc(p.phase)}` : ''}</span>`);
      parts.push('<span class="meter busy"><span></span></span>');
    } else if (p && p.nextAt) {
      const total = s.effectiveIntervalMs * 1.2;
      const rest = p.nextAt - serverNow();
      const pct = Math.min(100, Math.max(0, 100 - (rest / total) * 100));
      parts.push(`<span>下一轮 <b data-next="${p.nextAt}">${countdown(rest)}</b> 后</span>`);
      parts.push(`<span class="meter"><span data-meter="${p.nextAt}" data-total="${total}" style="width:${pct}%"></span></span>`);
    }
    parts.push(interval);
    if (leftText) parts.push(`<span>还可刷新 <b>${leftText}</b></span>`);
  } else if (s.status !== 'done') {
    if (s.rounds > 0) parts.push(`<span>上次共查 <b>${s.rounds}</b> 轮</span>`);
    parts.push(interval);
    if (leftText) parts.push(`<span>还可刷新 <b>${leftText}</b></span>`);
    else parts.push('<span class="warnline">目标日期已进入 48 小时内，无法再刷新</span>');
  } else if (s.rounds > 0) {
    parts.push(`<span>共查 <b>${s.rounds}</b> 轮后改约成功</span>`);
  }
  return parts.length ? `<div class="run">${parts.join('')}</div>` : '';
}

/** 每秒更新倒计时，不重新拉数据 */
function tick() {
  for (const el of $$('[data-next]')) el.textContent = countdown(Number(el.dataset.next) - serverNow());
  for (const el of $$('[data-meter]')) {
    const rest = Number(el.dataset.meter) - serverNow();
    el.style.width = `${Math.min(100, Math.max(0, 100 - (rest / Number(el.dataset.total)) * 100))}%`;
  }
  // 倒计时走完，下一轮应该开始了，拉一次最新状态
  if ($$('[data-next]').some((el) => Number(el.dataset.next) - serverNow() < -1500) && !reloading) void reload();
}

function renderStudents(list) {
  const box = $('#students');
  if (list.length === 0) {
    box.innerHTML = '<div class="empty"><img src="/logo.svg" class="logo" alt=""><p>还没有学员。点右上角"添加学员"，输入 Booking number 和姓氏即可。</p></div>';
    return;
  }
  box.innerHTML = list.map((s) => {
    const t = s.target;
    const names = t.centreIds.map(centreName).join('、') || '（未设置考点）';
    const dates = t.dateFrom === t.dateTo ? fmtDate(t.dateFrom) : `${fmtDate(t.dateFrom)} 至 ${fmtDate(t.dateTo)}`;
    return `<div class="card ${s.status}" data-id="${s.id}">
      <div class="head"><span class="name">${esc(s.label)}</span><span class="meta">Booking …${esc(s.bookingIdTail)}</span>
        <span class="status ${s.status}">${STATUS_TEXT[s.status] || s.status}</span></div>
      <div class="compare">
        <div class="box cur"><div class="k">📄 现有预约</div><div class="v">${esc(s.current.centreName)}</div><div class="s">${esc(fmtDate(s.current.date))} ${esc(s.current.time)}</div></div>
        <div class="arrow">→</div>
        <div class="box goal"><div class="k">🎯 目标</div><div class="v">${esc(names)}</div><div class="s">${esc(dates)}　${esc(describeTime(t))}</div></div>
      </div>
      ${runLine(s)}
      ${s.statusNote ? `<div class="note">${esc(s.statusNote)}</div>` : ''}
      <div class="actions">${studentActions(s)}</div></div>`;
  }).join('');
}

let logs = [];
let logsCollapsed = false;
function renderLogs() {
  const who = $('#log-student').value;
  const problems = $('#log-problems').checked;
  const byId = new Map(students.map((s) => [s.id, s.label]));
  const shown = logs.filter((l) => (!who || String(l.studentId) === who) && (!problems || l.level !== 'info'));
  $('#logs').innerHTML = shown.map((l) => `<div class="${esc(l.level)}">${esc(fmtStamp(l.at))}　${l.studentId ? `<span class="who">${esc(byId.get(l.studentId) ?? '')}</span>　` : ''}${esc(l.msg)}</div>`).join('') || '<span class="hint">暂无记录</span>';
  $('#logs').classList.toggle('collapsed', logsCollapsed);
  $('#log-toggle').textContent = logsCollapsed ? '展开' : '收起';
}
function renderLogFilter() {
  const sel = $('#log-student');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部学员</option>' + students.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  sel.value = students.some((s) => String(s.id) === cur) ? cur : '';
}
$('#log-student').onchange = renderLogs;
$('#log-problems').onchange = renderLogs;
$('#log-toggle').onclick = () => { logsCollapsed = !logsCollapsed; renderLogs(); };

let reloading = false;
async function reload() {
  reloading = true;
  try {
    const [body, offers, l] = await Promise.all([api('GET', '/api/students'), api('GET', '/api/offers'), api('GET', '/api/logs')]);
    clockSkew = body.now - Date.now();
    students = body.students; logs = l;
    const list = students;
    renderStats(list, offers); renderTodo(list, offers); renderStudents(list); renderLogFilter(); renderLogs();
  } finally { reloading = false; }
}

// ---------- 按钮 ----------

const ACCEPT_TEXT = {
  success: '改约成功',
  dry_run: '已走到确认页。自动改约还没有开启，所以没有提交，请到网站手动改约',
  gone: '这个考位已经没有了',
  failed: '提交时被别人抢先了',
  not_open: '这个考位已处理过',
  error: '出错了，请看运行记录',
};

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const holder = btn.closest('[data-offer],[data-id]');
  if (!holder) return;
  try {
    if (act === 'open-site') { await api('POST', '/api/open-site'); return; }
    if (holder.dataset.offer) {
      const id = holder.dataset.offer;
      if (act === 'dismiss') await api('POST', `/api/offers/${id}/dismiss`);
      else {
        btn.disabled = true; btn.textContent = '正在处理，约 1 分钟…';
        const { result } = await api('POST', `/api/offers/${id}/accept`);
        alert(ACCEPT_TEXT[result] || result);
      }
    } else {
      const id = holder.dataset.id;
      const s = students.find((x) => String(x.id) === id);
      if (act === 'start') await api('POST', `/api/students/${id}/start`);
      if (act === 'pause') await api('POST', `/api/students/${id}/pause`);
      if (act === 'delete' && confirm(`确定删除学员"${s?.label}"吗？删除后不再刷新，记录也一并删除。`)) await api('DELETE', `/api/students/${id}`);
      if (act === 'target') return openTarget(s);
      if (act === 'interval') return openInterval(s);
    }
  } catch (e) { alert(e.message); }
  await reload();
});

// ---------- 添加学员 ----------

$('#btn-add').onclick = () => { $('#form-add').reset(); $('#add-error').textContent = ''; $('#add-progress').hidden = true; $('#dlg-add').showModal(); };
$('#form-add').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const submit = $('#add-submit');
  submit.disabled = true; $('#add-cancel').disabled = true; submit.textContent = '正在读取…';
  $('#add-progress').hidden = false; $('#add-error').textContent = '';
  try {
    const s = await api('POST', '/api/students', { label: f.get('label'), bookingId: f.get('bookingId'), surname: f.get('surname') });
    $('#dlg-add').close();
    await reload();
    openTarget(s, true);
  } catch (e) { $('#add-error').textContent = e.message; }
  finally { submit.disabled = false; $('#add-cancel').disabled = false; submit.textContent = '添加并读取预约'; $('#add-progress').hidden = true; }
});
// 读取中不能用 Esc 关掉对话框，否则看不到结果
$('#dlg-add').addEventListener('cancel', (ev) => { if ($('#add-submit').disabled) ev.preventDefault(); });

// ---------- 设置目标 ----------

const TIMES = quarterTimes();
let editingId = null;
let chosen = new Set();
let pickedTimes = new Set();
let range = { from: '08:00', to: '17:00' };

function renderCentres() {
  const q = $('#centre-search').value.trim().toLowerCase();
  const list = state.centres.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.suburb || '').toLowerCase().includes(q) || (c.postcode || '').startsWith(q));
  $('#centre-list').innerHTML = list.map((c) => `<label><input type="checkbox" value="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}> ${esc(c.name)}<span class="suburb">${esc(c.suburb || '')} ${esc(c.postcode || '')}</span></label>`).join('')
    || '<p class="hint" style="padding:6px 10px">没有找到</p>';
  $('#centre-chosen').innerHTML = [...chosen].map((id) => `<span class="chip">${esc(centreName(id))}<button type="button" data-remove="${id}" title="去掉">×</button></span>`).join('');
  $('#centre-count').textContent = `已选 ${chosen.size} / ${state.maxCentres} 个`;
}
$('#centre-search').oninput = renderCentres;
$('#centre-list').onchange = (ev) => {
  const id = Number(ev.target.value);
  if (ev.target.checked && chosen.size >= state.maxCentres) {
    ev.target.checked = false;
    $('#target-error').textContent = `每个学员最多选 ${state.maxCentres} 个考点。考点越多一轮越慢，会拖慢所有学员`;
    return;
  }
  $('#target-error').textContent = '';
  if (ev.target.checked) chosen.add(id); else chosen.delete(id);
  renderCentres();
};
$('#centre-chosen').onclick = (ev) => {
  const id = ev.target.dataset?.remove;
  if (id) { chosen.delete(Number(id)); renderCentres(); }
};
// 搜索框里按回车不提交表单
$('#centre-search').onkeydown = (ev) => { if (ev.key === 'Enter') ev.preventDefault(); };

function fillTimeSelects() {
  const opts = TIMES.map((t) => `<option value="${t}">${t}</option>`).join('');
  $('#time-from').innerHTML = opts;
  $('#time-to').innerHTML = opts;
  $('#time-from').value = range.from;
  $('#time-to').value = range.to;
}
$('#time-from').onchange = (ev) => { range = onFromChange({ ...range, from: ev.target.value }); fillTimeSelects(); };
$('#time-to').onchange = (ev) => { range = onToChange({ ...range, to: ev.target.value }); fillTimeSelects(); };

function renderTimeGrid() {
  const hours = [...new Set(TIMES.map((t) => t.slice(0, 2)))];
  $('#time-grid').innerHTML = hours.map((h) => `<div class="hour-row"><span class="h">${h}点</span>${
    TIMES.filter((t) => t.startsWith(h)).map((t) => `<button type="button" data-time="${t}" class="${pickedTimes.has(t) ? 'on' : ''}">${t}</button>`).join('')
  }</div>`).join('');
}
$('#time-grid').onclick = (ev) => {
  const t = ev.target.dataset?.time;
  if (!t) return;
  if (pickedTimes.has(t)) pickedTimes.delete(t); else pickedTimes.add(t);
  renderTimeGrid();
};

const timeMode = () => $('#form-target').elements.timeMode.value;
function showTimeMode() {
  $('#time-range').hidden = timeMode() !== 'range';
  $('#time-times').hidden = timeMode() !== 'times';
}
for (const r of $$('input[name=timeMode]')) r.onchange = showTimeMode;

/** 不在 15 分钟档上的旧数据，向下取到最近一档 */
const snap = (t) => {
  const [h, m] = t.split(':').map(Number);
  const v = Math.min(Math.max(h * 60 + m - ((h * 60 + m) % 15), 6 * 60), 18 * 60);
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

function openTarget(s, fresh = false) {
  if (!s) return;
  editingId = s.id;
  const t = s.target;
  $('#target-title').textContent = `设置目标：${s.label}`;
  $('#target-current').textContent = `${fresh ? '已读取到现有预约：' : '现有预约：'}${s.current.centreName}，${fmtDate(s.current.date)} ${s.current.time}`;
  chosen = new Set(t.centreIds);
  $('#centre-search').value = '';
  renderCentres();
  const f = $('#form-target');
  f.elements.dateFrom.value = t.dateFrom;
  f.elements.dateTo.value = t.dateTo;
  range = { from: snap(t.timeFrom), to: snap(t.timeTo) };
  fillTimeSelects();
  pickedTimes = new Set(t.times || []);
  renderTimeGrid();
  f.elements.timeMode.value = t.times && t.times.length ? 'times' : 'range';
  showTimeMode();
  $('#target-error').textContent = '';
  $('#dlg-target').showModal();
}
// 最早日期改了、最晚日期比它早时，跟着改
$('#form-target').elements.dateFrom.addEventListener('change', (ev) => {
  const to = $('#form-target').elements.dateTo;
  if (!to.value || to.value < ev.target.value) to.value = ev.target.value;
});

$('#form-target').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const f = ev.target.elements;
  const mode = timeMode();
  const times = [...pickedTimes].sort();
  if (chosen.size === 0) { $('#target-error').textContent = '请至少选一个考点'; return; }
  const err = checkTime(mode, range, times);
  if (err) { $('#target-error').textContent = err; return; }
  const body = {
    centreIds: [...chosen],
    dateFrom: f.dateFrom.value, dateTo: f.dateTo.value,
    timeFrom: range.from, timeTo: range.to,
    times: mode === 'times' ? times : [],
  };
  try { await api('PUT', `/api/students/${editingId}/target`, body); $('#dlg-target').close(); await reload(); }
  catch (e) { $('#target-error').textContent = e.message; }
});

// ---------- 刷新设置 ----------

/** null = 全局设置；否则是正在设置的学员 */
let intervalFor = null;
function renderIntervalLabel() {
  $('#interval-label').textContent = `每 ${minutesLabel(state.intervalMs)}刷新`;
}
function showEstimate() {
  const v = $('#form-interval').elements.interval.value;
  const box = $('#interval-est');
  if (v === 'global') {
    box.textContent = `跟随全局设置（${minutesLabel(state.intervalMs)}）：${estimate(state.intervalMs / 60_000).text}`;
    box.className = 'interval-est';
    return;
  }
  const e = estimate(Number(v));
  box.textContent = e.text + (e.risky ? '。这是最快的档位，被站点拦截的风险最大，建议只在短时间内使用。' : '。');
  box.className = `interval-est ${e.risky ? 'risky' : ''}`;
}
function openInterval(s) {
  intervalFor = s ?? null;
  $('#interval-title').textContent = s ? `刷新间隔：${s.label}` : '刷新设置（所有学员）';
  $('#interval-scope').textContent = s
    ? '只对这个学员生效。一般跟随全局设置即可；比如这个学员不急，可以设长一点，把访问量留给别的学员。'
    : '所有学员默认用这个间隔。改了立刻生效，正在等待的学员按新间隔重新计时。';
  const current = s ? (s.intervalMs ? String(s.intervalMs / 60_000) : 'global') : String(state.intervalMs / 60_000);
  const opts = (s ? [['global', '跟随全局']] : []).concat(state.intervalChoicesMin.map((m) => [String(m), `${m} 分钟`]));
  $('#interval-choices').innerHTML = opts.map(([v, t]) =>
    `<label><input type="radio" name="interval" value="${v}" ${v === current ? 'checked' : ''}> ${t}${v === '2' ? ' <span class="rec">推荐</span>' : ''}</label>`).join('');
  $('#interval-help').innerHTML = state.intervalHelp.map((p) => `<p>${esc(p)}</p>`).join('');
  $('#interval-error').textContent = '';
  showEstimate();
  $('#dlg-interval').showModal();
}
$('#interval-choices').onchange = showEstimate;
$('#btn-interval').onclick = () => openInterval(null);
$('#form-interval').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const v = ev.target.elements.interval.value;
  try {
    if (intervalFor) await api('PUT', `/api/students/${intervalFor.id}/interval`, { ms: v === 'global' ? null : Number(v) * 60_000 });
    else {
      const r = await api('PUT', '/api/settings/interval', { ms: Number(v) * 60_000 });
      state.intervalMs = r.intervalMs;
      renderIntervalLabel();
    }
    $('#dlg-interval').close();
    await reload();
  } catch (e) { $('#interval-error').textContent = e.message; }
});

// ---------- 授权 ----------

function renderLicense(l) {
  state.license = l;
  $('#license-box').hidden = l.ok;
  $('#license-msg').textContent = l.ok ? '' : l.message;
  const tag = $('#license-tag');
  tag.hidden = !l.ok || !l.until;
  if (l.ok && l.until) tag.textContent = `试用至 ${l.until}`;
}
$('#license-file').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  $('#license-error').textContent = '';
  try {
    renderLicense(await api('POST', '/api/license', { text: await file.text() }));
    await reload();
  } catch (e) { $('#license-error').textContent = e.message; }
};

// ---------- 桌面通知与启动 ----------

function notify(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(msg.title, { body: msg.body, requireInteraction: msg.level === 'attention', icon: '/logo.svg' });
}
$('#btn-notify').onclick = async () => { await Notification.requestPermission(); $('#btn-notify').hidden = Notification.permission === 'granted'; };

try {
  state = await api('GET', '/api/state');
  centreById = new Map(state.centres.map((c) => [c.id, c]));
  const mode = $('#mode');
  mode.textContent = state.autoRebookEnabled ? '自动改约：已开启' : '自动改约：未开启 · 只走到确认页';
  mode.className = `sign ${state.autoRebookEnabled ? 'on' : 'off'}`;
  renderIntervalLabel();
  renderLicense(state.license);
  $('#btn-notify').hidden = !('Notification' in window) || Notification.permission === 'granted';
  await reload();
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  es.addEventListener('message', async (e) => { notify(JSON.parse(e.data)); await reload(); });
  setInterval(reload, 30000);
  // 到期时间到了要立刻显示，不等重启
  setInterval(async () => { try { renderLicense(await api('GET', '/api/license')); } catch { /* 下次再试 */ } }, 60000);
  setInterval(tick, 1000);
} catch (e) {
  document.body.innerHTML = `<p style="padding:20px">打不开：${esc(e.message)}。请用软件启动的窗口，不要手动改地址。</p>`;
}
