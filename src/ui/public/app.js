const token = new URLSearchParams(location.search).get('t') || '';
const $ = (s) => document.querySelector(s);
let state = { centres: [], autoRebookEnabled: false };
let centreName = new Map();

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

const STATUS_TEXT = { idle: '未开始', running: '刷新中', pending_confirm: '等你确认', done: '已改约', stopped: '已停止', paused: '已暂停' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

function renderStudents(list) {
  const box = $('#students');
  if (list.length === 0) { box.innerHTML = '<p class="hint">还没有学员，点右上角"添加学员"。</p>'; return; }
  box.innerHTML = list.map((s) => {
    const names = s.target.centreIds.map((id) => centreName.get(id) || id).join('、') || '（未设置）';
    const running = s.status === 'running';
    return `<div class="card ${s.status === 'pending_confirm' ? 'attention' : ''}" data-id="${s.id}">
      <div class="row"><strong>${esc(s.label)} <span class="meta">（Booking …${esc(s.bookingIdTail)}）</span></strong>
        <span class="status ${s.status}">${STATUS_TEXT[s.status] || s.status}</span></div>
      <div class="meta">现有预约：${esc(s.current.centreName)}　${esc(s.current.date)} ${esc(s.current.time)}</div>
      <div class="meta">目标：${esc(names)}　${esc(s.target.dateFrom)} 至 ${esc(s.target.dateTo)}　${esc(s.target.timeFrom)}–${esc(s.target.timeTo)}</div>
      ${s.statusNote ? `<div class="meta">${esc(s.statusNote)}</div>` : ''}
      <div class="actions">
        <button data-act="target">设置目标</button>
        ${running ? '<button data-act="pause">暂停</button>' : s.status === 'done' ? '' : '<button class="primary" data-act="start">开始刷新</button>'}
        <button class="danger" data-act="delete">删除</button>
      </div></div>`;
  }).join('');
}

function renderOffers(list, students) {
  const byId = new Map(students.map((s) => [s.id, s]));
  $('#offers-box').hidden = list.length === 0;
  $('#offers').innerHTML = list.map((o) => `<div class="card attention" data-offer="${o.id}">
    <strong>${esc(byId.get(o.studentId)?.label ?? '学员')}</strong>
    <div>${esc(centreName.get(o.centreId) || o.centreId)}　${esc(o.date)} ${esc(o.time)}</div>
    <div class="meta">${o.notes.map(esc).join('；')}</div>
    <div class="actions"><button class="primary" data-act="accept">改到这个时间</button><button data-act="dismiss">忽略</button></div>
  </div>`).join('');
}

function renderLogs(list) {
  $('#logs').innerHTML = list.map((l) => `<div class="${esc(l.level)}">${esc(fmtTime(l.at))}　${esc(l.msg)}</div>`).join('') || '<span class="hint">暂无记录</span>';
}

async function refresh() {
  const [students, offers, logs] = await Promise.all([api('GET', '/api/students'), api('GET', '/api/offers'), api('GET', '/api/logs')]);
  renderStudents(students); renderOffers(offers, students); renderLogs(logs);
  return students;
}

let students = [];
async function reload() { students = await refresh(); }

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const card = btn.closest('.card');
  try {
    if (card.dataset.offer) {
      const id = card.dataset.offer;
      if (act === 'dismiss') await api('POST', `/api/offers/${id}/dismiss`);
      else {
        btn.disabled = true; btn.textContent = '正在处理…';
        const { result } = await api('POST', `/api/offers/${id}/accept`);
        alert({ success: '改约成功', dry_run: '已走到确认页。自动改约还没有开启，所以没有提交', gone: '这个考位已经没有了', failed: '提交时被别人抢先了', not_open: '这个考位已处理过', error: '出错了，请看运行记录' }[result] || result);
      }
    } else {
      const id = card.dataset.id;
      if (act === 'start') await api('POST', `/api/students/${id}/start`);
      if (act === 'pause') await api('POST', `/api/students/${id}/pause`);
      if (act === 'delete' && confirm('确定删除这个学员吗？')) await api('DELETE', `/api/students/${id}`);
      if (act === 'target') return openTarget(students.find((s) => String(s.id) === id));
    }
  } catch (e) { alert(e.message); }
  await reload();
});

// 添加学员
$('#btn-add').onclick = () => { $('#form-add').reset(); $('#add-error').textContent = ''; $('#dlg-add').showModal(); };
$('#form-add').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const submit = $('#add-submit'); submit.disabled = true; submit.textContent = '正在登录读取…';
  try {
    await api('POST', '/api/students', { label: f.get('label'), bookingId: f.get('bookingId'), surname: f.get('surname') });
    $('#dlg-add').close();
    await reload();
  } catch (e) { $('#add-error').textContent = e.message; }
  finally { submit.disabled = false; submit.textContent = '添加'; }
});

// 设置目标
let editingId = null;
function openTarget(s) {
  editingId = s.id;
  $('#target-title').textContent = `设置目标：${s.label}`;
  const sel = $('#centre-select');
  sel.innerHTML = state.centres.map((c) => `<option value="${c.id}" ${s.target.centreIds.includes(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const f = $('#form-target');
  for (const k of ['dateFrom', 'dateTo', 'timeFrom', 'timeTo']) f.elements[k].value = s.target[k];
  $('#target-error').textContent = '';
  $('#dlg-target').showModal();
}
$('#form-target').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  ev.preventDefault();
  const f = ev.target.elements;
  const body = {
    centreIds: [...f.centreIds.selectedOptions].map((o) => Number(o.value)),
    dateFrom: f.dateFrom.value, dateTo: f.dateTo.value, timeFrom: f.timeFrom.value, timeTo: f.timeTo.value,
  };
  try { await api('PUT', `/api/students/${editingId}/target`, body); $('#dlg-target').close(); await reload(); }
  catch (e) { $('#target-error').textContent = e.message; }
});

// 桌面通知
function notify(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(msg.title, { body: msg.body, requireInteraction: msg.level === 'attention' });
}
$('#btn-notify').onclick = async () => { await Notification.requestPermission(); $('#btn-notify').hidden = Notification.permission === 'granted'; };

(async () => {
  try {
    state = await api('GET', '/api/state');
    centreName = new Map(state.centres.map((c) => [c.id, c.name]));
    $('#mode').textContent = state.autoRebookEnabled ? '自动改约：已开启' : '自动改约：未开启（只走到确认页）';
    $('#btn-notify').hidden = !('Notification' in window) || Notification.permission === 'granted';
    await reload();
  } catch (e) { document.body.innerHTML = `<p style="padding:20px">打不开：${esc(e.message)}。请用软件启动的窗口，不要手动改地址。</p>`; return; }
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  es.addEventListener('message', async (e) => { notify(JSON.parse(e.data)); await reload(); });
  setInterval(reload, 30000);
})();
