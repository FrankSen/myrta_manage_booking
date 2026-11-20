import { checkTime, describeTime as describeTime0, onFromChange, onToChange, quarterTimes } from './time-options.js';
import { countdown, cycleLabel as cycleLabel0, estimate as estimate0, minutesLabel as minutesLabel0, remaining as remaining0 } from './format.js';
import { DEFAULT_LANG, fmtDate as fmtDate0, fmtStamp as fmtStamp0, render, t } from './i18n.js';

// 当前界面语言。所有显示文字都经过 tr / txt，切换语言后整页重新渲染
let lang = DEFAULT_LANG;
const tr = (key, args) => t(lang, key, args);
/** 服务端返回的文字：可能是普通字符串，也可能是待翻译的消息 */
const txt = (x) => render(lang, x);
const describeTime = (target) => describeTime0(target, lang);
const cycleLabel = (ms) => cycleLabel0(ms, lang);
const estimate = (m) => estimate0(m, lang);
const minutesLabel = (ms) => minutesLabel0(ms, lang);
const remaining = (ms) => remaining0(ms, lang);

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
  if (!res.ok) throw new Error(data.error ? txt(data.error) : tr('err.http', { status: res.status }));
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => fmtDate0(lang, d);
// 一律按悉尼时间显示，不跟电脑时区走
const fmtStamp = (ms) => fmtStamp0(lang, ms);
const centreName = (id) => centreById.get(id)?.name || tr('centre.unknown', { id });
const statusText = (st) => tr(`st.${st}`);
const isManualPause = (note) => note && typeof note === 'object' && note.k === 'status.manual_pause' || note === '教练手动暂停';

// ---------- 渲染 ----------

function renderStats(list, offers) {
  const n = (st) => list.filter((s) => s.status === st).length;
  const todo = offers.length + n('pending_confirm') + n('paused');
  $('#stats').innerHTML = [
    ['go', n('running'), tr('stats.running')],
    ['wait', todo, tr('stats.todo')],
    ['info', n('done'), tr('stats.done')],
    ['', list.length, tr('stats.total')],
  ].map(([c, v, t]) => `<div class="stat"><span class="light ${c}" ${c ? '' : 'style="background:var(--idle)"'}></span><div><b>${v}</b><br><span>${t}</span></div></div>`).join('');
}

function renderTodo(list, offers) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const items = [];
  for (const o of offers) {
    items.push(`<div class="todo-item" data-offer="${o.id}">
      <div><span class="tag near">${tr('tag.near')}</span><span class="what">${esc(byId.get(o.studentId)?.label ?? tr('todo.student'))}${tr('run.phase_sep')}${esc(centreName(o.centreId))} ${esc(fmtDate(o.date))} ${esc(o.time)}</span>
        <div class="hint">${o.notes.map((x) => esc(txt(x))).join(tr('list.notes_sep'))}</div></div>
      <div class="actions"><button class="primary" data-act="accept">${tr('btn.accept')}</button><button data-act="dismiss">${tr('btn.dismiss')}</button></div>
    </div>`);
  }
  for (const s of list.filter((x) => x.status === 'pending_confirm' && x.hold)) {
    const h = s.hold;
    items.push(`<div class="todo-item hold" data-id="${s.id}">
      <div><span class="tag found">${tr('tag.found')}</span><span class="what">${esc(s.label)}${tr('run.phase_sep')}${esc(centreName(h.slot.centreId))} ${esc(fmtDate(h.slot.date))} ${esc(h.slot.time)}</span>
        <div class="hint">${esc(tr('todo.hold_hint', { centre: centreName(h.slot.centreId), date: fmtDate(h.slot.date), time: h.slot.time }))}</div>
        <div class="hint">${tr('todo.hold_left', { t: `<b data-hold="${h.until}">${countdown(h.until - serverNow())}</b>` })}</div></div>
      <div class="actions">${holdButtons()}</div>
    </div>`);
  }
  for (const s of list.filter((x) => x.status === 'pending_confirm' && !x.hold)) {
    items.push(`<div class="todo-item" data-id="${s.id}">
      <div><span class="tag found">${tr('tag.found')}</span><span class="what">${esc(s.label)}</span>
        <div class="hint">${esc(tr('todo.found_hint', { note: txt(s.statusNote) }))}</div></div>
      <div class="actions"><button class="warn" data-act="open-site">${tr('btn.open_site')}</button><button data-act="start">${tr('btn.continue')}</button></div>
    </div>`);
  }
  for (const s of list.filter((x) => x.status === 'paused' && x.statusNote && !isManualPause(x.statusNote))) {
    items.push(`<div class="todo-item" data-id="${s.id}">
      <div><span class="tag" style="background:#fbe0dd;color:#a8261c">${tr('tag.error')}</span><span class="what">${esc(s.label)}</span>
        <div class="hint">${esc(txt(s.statusNote))}</div></div>
      <div class="actions"><button class="primary" data-act="start">${tr('btn.restart')}</button></div>
    </div>`);
  }
  $('#todo-box').hidden = items.length === 0;
  $('#todo').innerHTML = items.join('');
}

function holdButtons() {
  return `<button class="primary" data-act="hold-submitted">${tr('btn.hold_submitted')}</button>`
    + `<button data-act="hold-reveal">${tr('btn.hold_reveal')}</button>`
    + `<button data-act="hold-abandon">${tr('btn.hold_abandon')}</button>`;
}

function studentActions(s) {
  const b = [];
  if (s.hold) b.push(holdButtons());
  else if (s.status === 'running') {
    b.push(`<button data-act="pause">${tr('btn.pause')}</button>`);
    if (!s.progress?.running) b.push(`<button data-act="check-now" title="${esc(tr('btn.check_now_title'))}">${tr('btn.check_now')}</button>`);
  }
  else if (s.status !== 'done') b.push(`<button class="primary" data-act="start">${tr(s.status === 'idle' ? 'btn.start' : 'btn.resume')}</button>`);
  if (s.status === 'pending_confirm' && !s.hold) b.push(`<button class="warn" data-act="open-site">${tr('btn.open_site')}</button>`);
  // 接让位的学员目标固定为对方的考位，不能改
  if (s.handoverFrom === null || s.handoverFrom === undefined) b.push(`<button data-act="target">${tr('btn.target')}</button>`);
  if (s.status !== 'done') b.push(`<button data-act="interval">${tr('btn.interval')}</button>`);
  if (s.handoverTo || s.handoverFrom) b.push(`<button data-act="handover-clear">${tr('btn.handover_clear')}</button>`);
  else if (s.status !== 'done') b.push(`<button data-act="handover" title="${esc(tr('btn.handover_title'))}">${tr('btn.handover')}</button>`);
  b.push(`<button class="danger" data-act="delete">${tr('btn.delete')}</button>`);
  return b.join('');
}

/** 让位关系：让给谁 / 接谁的考位 */
function handoverLine(s) {
  const label = (id) => students.find((x) => x.id === id)?.label ?? '';
  if (s.handoverTo) return `<div class="handover">${esc(tr('card.handover_to', { who: label(s.handoverTo) }))}</div>`;
  if (s.handoverFrom) return `<div class="handover">${esc(tr('card.handover_from', { who: label(s.handoverFrom) }))}</div>`;
  return '';
}

/** 刷新进度行：第几轮、下一轮倒计时、正在做什么、还能刷新多久、间隔 */
function runLine(s) {
  const parts = [];
  const left = s.deadline ? s.deadline.at - serverNow() : 0;
  const leftText = remaining(left);
  const b = (x) => `<b>${esc(x)}</b>`;
  const interval = `<span>${tr('run.interval', { min: b(minutesLabel(s.effectiveIntervalMs)), own: s.intervalMs ? tr('run.own') : '' })}</span>`
    + (s.expectedCycleMs ? `<span title="${esc(tr('run.cycle_title'))}">${tr('run.cycle', { min: b(cycleLabel(s.expectedCycleMs)) })}</span>` : '');
  if (s.status === 'running') {
    parts.push(`<span>${tr('run.rounds', { n: b(s.rounds) })}</span>`);
    const p = s.progress;
    if (p && p.running) {
      parts.push(`<span class="now">${tr('run.in_progress', { n: s.rounds + 1, phase: p.phase ? tr('run.phase_sep') + esc(txt(p.phase)) : '' })}</span>`);
      parts.push('<span class="meter busy"><span></span></span>');
    } else if (p && p.nextAt) {
      const total = s.effectiveIntervalMs * 1.2;
      const rest = p.nextAt - serverNow();
      const pct = Math.min(100, Math.max(0, 100 - (rest / total) * 100));
      parts.push(`<span>${tr('run.next', { t: `<b data-next="${p.nextAt}">${countdown(rest)}</b>` })}</span>`);
      parts.push(`<span class="meter"><span data-meter="${p.nextAt}" data-total="${total}" style="width:${pct}%"></span></span>`);
    }
    parts.push(interval);
    if (leftText) parts.push(`<span>${tr('run.left', { t: b(leftText) })}</span>`);
  } else if (s.status !== 'done') {
    if (s.rounds > 0) parts.push(`<span>${tr('run.last_rounds', { n: b(s.rounds) })}</span>`);
    parts.push(interval);
    if (leftText) parts.push(`<span>${tr('run.left', { t: b(leftText) })}</span>`);
    else parts.push(`<span class="warnline">${tr('run.locked')}</span>`);
  } else if (s.rounds > 0) {
    parts.push(`<span>${tr('run.done_rounds', { n: b(s.rounds) })}</span>`);
  }
  return parts.length ? `<div class="run">${parts.join('')}</div>` : '';
}

/** 每秒更新倒计时，不重新拉数据 */
function tick() {
  for (const el of $$('[data-next]')) el.textContent = countdown(Number(el.dataset.next) - serverNow());
  for (const el of $$('[data-hold]')) el.textContent = countdown(Number(el.dataset.hold) - serverNow());
  for (const el of $$('[data-meter]')) {
    const rest = Number(el.dataset.meter) - serverNow();
    el.style.width = `${Math.min(100, Math.max(0, 100 - (rest / Number(el.dataset.total)) * 100))}%`;
  }
  // 倒计时走完，下一轮应该开始了，拉一次最新状态
  if ($$('[data-next],[data-hold]').some((el) => Number(el.dataset.next ?? el.dataset.hold) - serverNow() < -1500) && !reloading) void reload();
}

function renderStudents(list) {
  const box = $('#students');
  if (list.length === 0) {
    box.innerHTML = `<div class="empty"><img src="/logo.svg" class="logo" alt=""><p>${esc(tr('students.empty'))}</p></div>`;
    return;
  }
  box.innerHTML = list.map((s) => {
    const t = s.target;
    const names = t.centreIds.map(centreName).join(tr('list.sep')) || tr('card.no_centre');
    const dates = t.dateFrom === t.dateTo ? fmtDate(t.dateFrom) : tr('card.dates_range', { from: fmtDate(t.dateFrom), to: fmtDate(t.dateTo) });
    return `<div class="card ${s.status}" data-id="${s.id}">
      <div class="head"><span class="name">${esc(s.label)}</span><span class="meta">Booking …${esc(s.bookingIdTail)}</span>
        <span class="status ${s.status}">${esc(statusText(s.status))}</span></div>
      <div class="compare">
        <div class="box cur"><div class="k">${tr('card.current')}</div><div class="v">${esc(s.current.centreName)}</div><div class="s">${esc(fmtDate(s.current.date))} ${esc(s.current.time)}</div></div>
        <div class="arrow">→</div>
        <div class="box goal"><div class="k">${tr('card.goal')}</div><div class="v">${esc(names)}</div><div class="s">${esc(dates)}　${esc(describeTime(t))}</div></div>
      </div>
      ${handoverLine(s)}
      ${runLine(s)}
      ${s.statusNote ? `<div class="note">${esc(txt(s.statusNote))}</div>` : ''}
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
  $('#logs').innerHTML = shown.map((l) => `<div class="${esc(l.level)}">${esc(fmtStamp(l.at))}　${l.studentId ? `<span class="who">${esc(byId.get(l.studentId) ?? '')}</span>　` : ''}${esc(txt(l.msg))}</div>`).join('') || `<span class="hint">${tr('logs.empty')}</span>`;
  $('#logs').classList.toggle('collapsed', logsCollapsed);
  $('#log-toggle').textContent = tr(logsCollapsed ? 'logs.expand' : 'logs.collapse');
}
function renderLogFilter() {
  const sel = $('#log-student');
  const cur = sel.value;
  sel.innerHTML = `<option value="">${esc(tr('logs.all'))}</option>` + students.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
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
        btn.disabled = true; btn.textContent = tr('accept.working');
        const { result } = await api('POST', `/api/offers/${id}/accept`);
        alert(tr(`accept.${result}`));
      }
    } else {
      const id = holder.dataset.id;
      const s = students.find((x) => String(x.id) === id);
      if (act === 'hold-reveal') { await api('POST', `/api/students/${id}/hold/reveal`); return; }
      if (act === 'hold-abandon' || act === 'hold-submitted') {
        const h = s?.hold;
        if (act === 'hold-abandon' && h && !confirm(tr('confirm.hold_abandon', { centre: centreName(h.slot.centreId), date: fmtDate(h.slot.date), time: h.slot.time }))) return;
        for (const b of $$(`[data-id="${id}"] button`)) b.disabled = true;
        btn.textContent = tr('hold.working');
        const { result } = await api('POST', `/api/students/${id}/hold/${act === 'hold-abandon' ? 'abandon' : 'submitted'}`);
        alert(tr(`hold.${result}`));
      }
      if (act === 'check-now') await api('POST', `/api/students/${id}/check-now`);
      if (act === 'start') await api('POST', `/api/students/${id}/start`);
      if (act === 'pause') await api('POST', `/api/students/${id}/pause`);
      if (act === 'delete' && confirm(tr('confirm.delete', { label: s?.label ?? '' }))) await api('DELETE', `/api/students/${id}`);
      if (act === 'target') return openTarget(s);
      if (act === 'interval') return openInterval(s);
      if (act === 'handover') return openHandover(s);
      if (act === 'handover-clear') {
        // 解除总是对让出方（A）操作
        const a = s.handoverTo ? s : students.find((x) => x.id === s.handoverFrom);
        const b = students.find((x) => x.id === (a?.handoverTo));
        if (a && confirm(tr('confirm.handover_clear', { a: a.label, b: b?.label ?? '' }))) await api('PUT', `/api/students/${a.id}/handover`, { to: null });
      }
    }
  } catch (e) { alert(e.message); }
  await reload();
});

// ---------- 让位 ----------

let handoverFrom = null;
function openHandover(s) {
  handoverFrom = s;
  // 一对一、不串联：只列出没在任何让位里、还没完成的其他学员
  const free = students.filter((x) => x.id !== s.id && x.status !== 'done' && !x.handoverTo && !x.handoverFrom);
  $('#handover-intro').textContent = tr('handover.intro', { who: s.label, centre: s.current.centreName, date: fmtDate(s.current.date), time: s.current.time });
  $('#handover-to').innerHTML = free.map((x) => `<option value="${x.id}">${esc(x.label)}（Booking …${esc(x.bookingIdTail)}）</option>`).join('');
  $('#handover-none').hidden = free.length > 0;
  $('#handover-submit').disabled = free.length === 0;
  $('#handover-error').textContent = '';
  $('#dlg-handover').showModal();
}
$('#form-handover').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  try {
    await api('PUT', `/api/students/${handoverFrom.id}/handover`, { to: Number($('#handover-to').value) });
    $('#dlg-handover').close();
    await reload();
  } catch (e) { $('#handover-error').textContent = e.message; }
});

// ---------- 添加学员 ----------

$('#btn-add').onclick = () => { $('#form-add').reset(); $('#add-error').textContent = ''; $('#add-progress').hidden = true; $('#dlg-add').showModal(); $('#form-add').elements.label.focus(); };
let addReading = false;
$('#form-add').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const submit = $('#add-submit');
  submit.disabled = true; submit.textContent = tr('add.reading');
  $('#add-progress').hidden = false; $('#add-error').textContent = '';
  addReading = true;
  try {
    const s = await api('POST', '/api/students', { label: f.get('label'), bookingId: f.get('bookingId'), surname: f.get('surname') }).finally(() => { addReading = false; });
    $('#dlg-add').close();
    await reload();
    openTarget(s, true);
  } catch (e) { $('#add-error').textContent = e.message; }
  finally { submit.disabled = false; submit.textContent = tr('add.submit'); $('#add-progress').hidden = true; }
});
// 读取中点"取消"或按 Esc：中断读取（关掉读取用的浏览器），关闭对话框
$('#dlg-add').addEventListener('close', () => {
  if (addReading) void api('POST', '/api/students/cancel-read').catch(() => {});
});

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
    || `<p class="hint" style="padding:6px 10px">${tr('target.not_found')}</p>`;
  $('#centre-chosen').innerHTML = [...chosen].map((id) => `<span class="chip">${esc(centreName(id))}<button type="button" data-remove="${id}" title="${esc(tr('target.remove'))}">×</button></span>`).join('');
  $('#centre-count').textContent = tr('target.count', { n: chosen.size, max: state.maxCentres });
}
$('#centre-search').oninput = renderCentres;
$('#centre-list').onchange = (ev) => {
  const id = Number(ev.target.value);
  if (ev.target.checked && chosen.size >= state.maxCentres) {
    ev.target.checked = false;
    $('#target-error').textContent = tr('target.max_centres', { max: state.maxCentres });
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
  $('#time-grid').innerHTML = hours.map((h) => `<div class="hour-row"><span class="h">${tr('target.hour', { h })}</span>${
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
  $('#target-title').textContent = tr('target.title', { label: s.label });
  $('#target-current').textContent = tr(fresh ? 'target.current_fresh' : 'target.current', { centre: s.current.centreName, date: fmtDate(s.current.date), time: s.current.time });
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
  if (chosen.size === 0) { $('#target-error').textContent = tr('target.need_centre'); return; }
  const err = checkTime(mode, range, times, lang);
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
  $('#interval-label').textContent = tr('top.every', { min: minutesLabel(state.intervalMs) });
}
function showEstimate() {
  const v = $('#form-interval').elements.interval.value;
  const box = $('#interval-est');
  if (v === 'global') {
    box.textContent = tr('interval.follow_est', { min: minutesLabel(state.intervalMs), est: estimate(state.intervalMs).text });
    box.className = 'interval-est';
    return;
  }
  const e = estimate(Number(v));
  box.textContent = e.text + tr(e.risky ? 'interval.risky' : 'interval.period');
  box.className = `interval-est ${e.risky ? 'risky' : ''}`;
}
function openInterval(s) {
  intervalFor = s ?? null;
  $('#interval-title').textContent = s ? tr('interval.title_student', { label: s.label }) : tr('interval.title_global');
  $('#interval-scope').textContent = tr(s ? 'interval.scope_student' : 'interval.scope_global');
  const current = s ? (s.intervalMs ? String(s.intervalMs) : 'global') : String(state.intervalMs);
  const rec = String(5 * 60_000);
  const opts = (s ? [['global', tr('interval.follow')]] : []).concat(state.intervalChoicesMs.map((ms) => [String(ms), minutesLabel(ms)]));
  $('#interval-choices').innerHTML = opts.map(([v, label]) =>
    `<label><input type="radio" name="interval" value="${v}" ${v === current ? 'checked' : ''}> ${esc(label)}${v === rec ? ` <span class="rec">${tr('interval.recommended')}</span>` : ''}</label>`).join('');
  $('#interval-help').innerHTML = state.intervalHelp.map((p) => `<p>${esc(txt(p))}</p>`).join('');
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
    if (intervalFor) await api('PUT', `/api/students/${intervalFor.id}/interval`, { ms: v === 'global' ? null : Number(v) });
    else {
      const r = await api('PUT', '/api/settings/interval', { ms: Number(v) });
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
  $('#license-msg').textContent = l.ok ? '' : txt(l.message);
  const tag = $('#license-tag');
  tag.hidden = !l.ok || !l.until;
  if (l.ok && l.until) tag.textContent = tr('license.tag', { until: l.until });
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

function notify(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(txt(m.title), { body: txt(m.body), requireInteraction: m.level === 'attention', icon: '/logo.svg' });
}

// ---------- 语言 ----------

/** 填页面上固定的文字 */
function applyStatic() {
  document.documentElement.lang = lang === 'en' ? 'en-AU' : 'zh-CN';
  for (const el of $$('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of $$('[data-i18n-html]')) el.innerHTML = tr(el.dataset.i18nHtml);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = tr(el.dataset.i18nPh);
  for (const el of $$('[data-i18n-title]')) el.title = tr(el.dataset.i18nTitle);
  document.title = tr('app.title');
}
$('#mode').onclick = async () => {
  const next = !state.autoRebookEnabled;
  if (!confirm(tr(next ? 'mode.confirm_on' : 'mode.confirm_off'))) return;
  try {
    const r = await api('PUT', '/api/settings/auto-rebook', { enabled: next });
    state.autoRebookEnabled = r.autoRebookEnabled;
    renderMode();
  } catch (e) { alert(e.message); }
};
function renderMode() {
  const mode = $('#mode');
  mode.textContent = tr(state.autoRebookEnabled ? 'mode.on' : 'mode.off');
  mode.className = `sign ${state.autoRebookEnabled ? 'on' : 'off'}`;
}
$('#btn-lang').onclick = async () => {
  const next = lang === 'zh' ? 'en' : 'zh';
  try { await api('PUT', '/api/settings/language', { language: next }); } catch (e) { alert(e.message); return; }
  lang = next;
  applyStatic(); renderMode(); renderIntervalLabel(); renderLicense(state.license);
  for (const d of $$('dialog[open]')) d.close();
  await reload();
};
$('#btn-notify').onclick = async () => { await Notification.requestPermission(); $('#btn-notify').hidden = Notification.permission === 'granted'; };

// ---------- 飞书推送设置 ----------
function renderFeishuBtn() {
  const btn = $('#btn-feishu');
  // feishuWebhook 为 null 表示服务端没开启这个设置（没有 feishu 依赖），隐藏按钮
  btn.hidden = state.feishuWebhook === null || state.feishuWebhook === undefined;
  btn.classList.toggle('on', !!state.feishuWebhook);
}
$('#btn-feishu').onclick = () => {
  $('#form-feishu').elements.webhook.value = state.feishuWebhook || '';
  $('#feishu-error').textContent = '';
  $('#dlg-feishu').showModal();
};
$('#form-feishu').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const webhook = ev.target.elements.webhook.value.trim();
  try {
    const r = await api('PUT', '/api/settings/feishu', { webhook });
    state.feishuWebhook = r.feishuWebhook;
    renderFeishuBtn();
    $('#dlg-feishu').close();
  } catch (e) { $('#feishu-error').textContent = e.message; }
});

try {
  state = await api('GET', '/api/state');
  lang = state.language || DEFAULT_LANG;
  applyStatic();
  centreById = new Map(state.centres.map((c) => [c.id, c]));
  renderMode();
  renderIntervalLabel();
  renderFeishuBtn();
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
  document.body.innerHTML = `<p style="padding:20px">${esc(tr('err.open', { msg: e.message }))}</p>`;
}
