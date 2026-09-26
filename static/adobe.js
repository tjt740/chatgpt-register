const ADOBE_STATUS = {
  pending: '待生产',
  registering: '注册中',
  waiting_code: '等待验证码',
  registered: '已注册',
  register_failed: '注册失败',
  skipped: '已注册',
};

let page = 1;
const size = 20;
let adobeCache = {};
const adobeSelected = new Set();
let logTimer = null;
let logId = null;

let actionBusy = false;
let loadBusy = false;
let lastLoadError = '';
let lastRowsHTML = '';
let browserReady = false;
let codeId = null;

async function adobeJSON(path, options) {
  const r = await api(path, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '请求失败（HTTP ' + r.status + '）');
  return data;
}
function adobePost(path, body) {
  return adobeJSON(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
async function performAction(task) {
  if (actionBusy) return;
  actionBusy = true;
  syncBatchBar();
  try { await task(); }
  catch (error) { toast(error.message || '网络请求失败，请重试', true); }
  finally {
    actionBusy = false;
    syncBatchBar();
    await load();
    await loadProduce();
  }
}
function canAdobeAction(x, action) {
  if (!x) return false;
  const session = x.status === 'registered' && x.has_auth;
  if (action === 'retry') return browserReady && x.can_retry;
  if (action === 'session') return !!session;
  if (action === 'email') return !!String(x.email || '').trim();
  if (action === 'rescue') return browserReady && session && x.alive === 'dead';
  if (action === 'stop') return ['registering', 'waiting_code'].includes(x.status);
  if (action === 'code') return x.status === 'waiting_code';
  return action === 'delete';
}
const ACTION_REASON = {
  retry: '仅待注册或注册失败且没有会话的账号可重试；需浏览器就绪',
  session: '注册成功并保存会话后才可测活或导出 Cookie',
  email: '请先选择有邮箱的账号',
  rescue: '仅已注册、测活失效且有会话的账号可救回；需浏览器就绪',
  stop: '仅正在注册或等待验证码的任务可停止',
  code: '仅等待验证码时可提交',
};
function actionAttrs(x, action, label) {
  const enabled = !actionBusy && canAdobeAction(x, action);
  return `data-adobe-action="${action}" data-id="${x.id}" data-label="${esc(label)}" aria-label="${esc(label)}" title="${esc(enabled ? label : label + '：' + (ACTION_REASON[action] || '操作进行中'))}" ${enabled ? '' : 'disabled'}`;
}
async function load() {
  if (loadBusy) return;
  loadBusy = true;
  try {
    const q = document.getElementById('search').value.trim();
    const status = document.getElementById('filter-status').value;
    const params = new URLSearchParams({ page, size });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const d = await adobeJSON('/api/adobe/registrations?' + params);
    const maxPage = Math.max(1, Math.ceil((d.total || 0) / size));
    if (page > maxPage) { page = maxPage; loadBusy = false; return load(); }
    adobeCache = {};
    (d.data || []).forEach(x => { adobeCache[x.id] = x; });
    // 选择限定于当前可见页，避免翻页/筛选后误操作隐藏记录。
    for (const id of adobeSelected) if (!adobeCache[id]) adobeSelected.delete(id);
    const rowsHTML = (d.data || []).map(rowHtml).join('')
      || '<tr><td colspan="8" style="text-align:center;color:var(--text-3)">暂无 Adobe 数据</td></tr>';
    if (rowsHTML !== lastRowsHTML) {
      document.getElementById('rows').innerHTML = rowsHTML;
      lastRowsHTML = rowsHTML;
    }
    renderPager('pager', page, maxPage, p => { page = p; load(); });
    syncBatchBar();
    lastLoadError = '';
  } catch (error) {
    if (lastLoadError !== error.message) toast('列表加载失败：' + error.message, true);
    lastLoadError = error.message;
  } finally { loadBusy = false; }
}

function rowHtml(x) {
  return `
    <tr class="${adobeSelected.has(x.id) ? 'row-sel' : ''}">
      <td class="col-check"><input type="checkbox" ${adobeSelected.has(x.id) ? 'checked' : ''} onclick="toggleSelect(${x.id}, this.checked)"></td>
      <td>${esc(x.email)}</td>
      <td>${fmtTime(x.created_at)}</td>
      <td class="adobe-status-cell"><span class="badge ${x.status === 'skipped' ? 'registered' : esc(x.status)}">${ADOBE_STATUS[x.status] || esc(x.status)}</span></td>
      <td class="adobe-info-cell"><div class="adobe-info" title="${esc(x.note || '')}">${esc(x.note || '—')}</div></td>
      <td>${aliveCell(x)}</td>
      <td class="ship-cell"><span class="badge ${x.shipped ? 'registered' : 'pending'}" title="导出后自动标记，不能手动修改">${x.shipped ? '已出库' : '未出库'}</span></td>
      <td><div class="adobe-row-actions">
        <button class="px-btn" onclick="showLog(${x.id})">查看日志</button>
        ${['pending', 'register_failed'].includes(x.status) ? `<button class="px-btn primary" ${actionAttrs(x, 'retry', '重新注册')} onclick="retryOne(${x.id})">重新注册</button>` : ''}
        ${['registering', 'waiting_code'].includes(x.status) ? `<button class="px-btn danger" ${actionAttrs(x, 'stop', '停止任务')} onclick="stopOne(${x.id})">停止任务</button>` : ''}
        ${x.status === 'waiting_code' ? `<button class="px-btn" ${actionAttrs(x, 'code', '输入验证码')} onclick="openCodeModal(${x.id})">输入验证码</button>` : ''}
        <button class="px-btn" ${actionAttrs(x, 'session', '检测存活')} onclick="liveCheckOne(${x.id})">检测存活</button>
        ${x.status === 'registered' && x.alive === 'dead' ? `<button class="px-btn" ${actionAttrs(x, 'rescue', '恢复会话')} onclick="rescueOne(${x.id})">恢复会话</button>` : ''}
        <button class="px-btn adobe-export adobe-export-string" ${actionAttrs(x, 'session', '导出 Cookie')} onclick="downloadAdobe(${x.id}, 'string')">导出 Cookie</button>
        <button class="px-btn adobe-export adobe-export-json" ${actionAttrs(x, 'session', '导出 JSON')} onclick="downloadAdobe(${x.id}, 'json')">导出 JSON</button>
        <button class="px-btn danger" ${actionAttrs(x, 'delete', '删除记录')} onclick="del(${x.id})">删除记录</button>
      </div>
      </td>
    </tr>`;
}

/* ===== 生产进度 ===== */
async function loadProduce() {
  try {
    const s = await adobeJSON('/api/adobe/produce/status');
    document.getElementById('pd-pending').textContent = s.pending || 0;
    document.getElementById('pd-running').textContent = s.running_num || 0;
    document.getElementById('pd-registered').textContent = s.registered || 0;
    document.getElementById('pd-failed').textContent = s.failed || 0;
    document.getElementById('pd-stop').style.display = s.running ? '' : 'none';
  } catch (e) { /* ignore */ }
}

/* 浏览器就绪状态：未就绪禁用生产 */
async function loadBrowserGate() {
  try {
    const s = await adobeJSON('/api/browser/status');
    browserReady = !!s.ready;
    const btn = document.getElementById('produce-btn');
    if (btn) {
      btn.disabled = actionBusy || !browserReady;
      btn.title = browserReady ? '' : (s.message || '缺少浏览器');
    }
    syncBatchBar();
  } catch (e) { browserReady = false; syncBatchBar(); }
}

let savedHeadless = true;
let modeSaving = false;
async function loadAdobeBrowserMode() {
  const toggle = document.getElementById('adobe-headless');
  try {
    const data = await adobeJSON('/api/adobe/browser-settings');
    savedHeadless = data.headless !== false;
    toggle.checked = savedHeadless;
    document.getElementById('adobe-mode-hint').textContent = (savedHeadless ? '无头模式已开启，浏览器在后台运行。' : '无头模式已关闭，将显示浏览器窗口。') + '对新启动的任务生效。';
    toggle.disabled = false;
  } catch (error) {
    toggle.disabled = true;
    document.getElementById('adobe-mode-hint').textContent = '读取浏览器模式失败，请刷新重试：' + error.message;
  }
}
async function saveAdobeBrowserMode() {
  if (modeSaving) return;
  const toggle = document.getElementById('adobe-headless');
  modeSaving = true;
  toggle.disabled = true;
  try {
    const data = await adobeJSON('/api/adobe/browser-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless: toggle.checked }),
    });
    savedHeadless = data.headless;
    document.getElementById('adobe-mode-hint').textContent = (savedHeadless ? '无头模式已开启，浏览器在后台运行。' : '无头模式已关闭，将显示浏览器窗口。') + '对新启动的任务生效。';
    toast('浏览器模式已保存');
  } catch (error) { toast('保存失败：' + error.message, true); }
  finally {
    toggle.checked = savedHeadless;
    toggle.disabled = false;
    modeSaving = false;
  }
}

function openProduceModal() {
  if (!browserReady) return toast('缺少浏览器，正在下载或下载失败，暂不能生产', true);
  document.getElementById('produce-count').value = 10;
  document.getElementById('produce-modal').style.display = 'flex';
}

function startProduce() {
  const count = Number(document.getElementById('produce-count').value);
  if (!Number.isInteger(count) || count < 1) return toast('请输入有效整数数量', true);
  return performAction(async () => {
    const d = await adobePost('/api/adobe/produce', { count });
    closeModal('produce-modal');
    toast('已启动 ' + (d.started || 0) + ' 个任务，验证码自动读取提交');
    page = 1;
  });
}
function stopProduce() {
  if (!confirm('确定停止当前所有 Adobe 生产任务?')) return;
  return performAction(async () => {
    await adobePost('/api/adobe/produce/stop');
    toast('已请求停止');
  });
}
function retryOne(id) {
  if (!canAdobeAction(adobeCache[id], 'retry')) return toast(ACTION_REASON.retry, true);
  return performAction(async () => {
    await adobePost('/api/adobe/registrations/' + id + '/retry');
    toast('已重新开始注册，保留原记录和历史日志');
    await showLog(id);
  });
}
function retrySelected() {
  return runSelected('retry', 'retry', '启动重试');
}
function stopOne(id) {
  if (!canAdobeAction(adobeCache[id], 'stop')) return toast(ACTION_REASON.stop, true);
  return performAction(async () => {
    await adobePost('/api/adobe/registrations/' + id + '/stop');
    toast('已请求停止 #' + id);
  });
}
function stopSelected() { return runSelected('stop', 'stop', '请求停止'); }
function openCodeModal(id) {
  if (!canAdobeAction(adobeCache[id], 'code')) return toast(ACTION_REASON.code, true);
  codeId = id;
  document.getElementById('adobe-code').value = '';
  document.getElementById('code-modal').style.display = 'flex';
}
function submitAdobeCode() {
  const code = document.getElementById('adobe-code').value.trim();
  if (!/^\d{6}$/.test(code)) return toast('请输入 6 位数字验证码', true);
  const id = codeId;
  if (!id) return;
  return performAction(async () => {
    await adobePost('/api/adobe/registrations/' + id + '/code', { code });
    closeModal('code-modal');
    codeId = null;
    toast('验证码已提交');
  });
}

/* ===== 多选 ===== */
function toggleSelect(id, checked) {
  if (checked) adobeSelected.add(id); else adobeSelected.delete(id);
  syncBatchBar();
}
function toggleSelectAll(checked) {
  Object.keys(adobeCache).forEach(id => {
    if (checked) adobeSelected.add(Number(id)); else adobeSelected.delete(Number(id));
  });
  load();
}
function clearSelection() { adobeSelected.clear(); load(); }
function syncBatchBar() {
  const bar = document.getElementById('adobe-batch');
  bar.style.display = adobeSelected.size ? 'flex' : 'none';
  document.getElementById('adobe-batch-count').textContent = '已选 ' + adobeSelected.size + ' 项';
  const ids = Object.keys(adobeCache).map(Number);
  const all = document.getElementById('adobe-check-all');
  all.checked = ids.length > 0 && ids.every(id => adobeSelected.has(id));
  all.indeterminate = ids.some(id => adobeSelected.has(id)) && !all.checked;
  document.querySelectorAll('[data-adobe-action]').forEach(button => {
    const action = button.dataset.adobeAction;
    const eligible = button.dataset.id
      ? canAdobeAction(adobeCache[button.dataset.id], action)
      : [...adobeSelected].some(id => canAdobeAction(adobeCache[id], action));
    button.disabled = actionBusy || !eligible;
    if (!eligible) button.title = (button.dataset.label ? button.dataset.label + '：' : '') + (ACTION_REASON[action] || '请先选择账号');
    else button.title = action === 'email' ? '导出所选邮箱，每行一个；不改变出库状态' : (button.dataset.id ? button.dataset.label : '仅处理所选符合条件的账号');
  });
  const help = document.getElementById('adobe-batch-help');
  if (help) {
    const n = action => [...adobeSelected].filter(id => canAdobeAction(adobeCache[id], action)).length;
    help.textContent = `可重试 ${n('retry')} 项 · 可测活/导出 Cookie ${n('session')} 项 · 可救回 ${n('rescue')} 项。邮箱导出包含所选各状态记录，不改变出库状态。`;
  }
  const produce = document.getElementById('produce-btn');
  if (produce) produce.disabled = actionBusy || !browserReady;
}
function selectedFor(action) {
  return [...adobeSelected].filter(id => canAdobeAction(adobeCache[id], action));
}
function runSelected(action, suffix, label, method = 'POST') {
  const ids = selectedFor(action);
  if (!ids.length) return toast(ACTION_REASON[action] || '请先选择账号', true);
  const skipped = adobeSelected.size - ids.length;
  if (!confirm(`对 ${ids.length} 项${label}？` + (skipped ? `将跳过 ${skipped} 项不符合条件的记录。` : ''))) return;
  return performAction(async () => {
    const failures = [];
    let done = 0;
    for (const id of ids) {
      try {
        await adobeJSON('/api/adobe/registrations/' + id + (suffix ? '/' + suffix : ''), { method });
        done++;
        if (method === 'DELETE') adobeSelected.delete(id);
      } catch (error) { failures.push('#' + id + ': ' + error.message); }
    }
    const summary = `${label} ${done} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`;
    toast(summary, failures.length > 0);
    const result = document.getElementById('adobe-action-result');
    result.textContent = summary + (failures.length ? '；' + failures.join('；') : '');
    result.hidden = false;
  });
}

/* 仅导出当前页所选邮箱，不含凭据，也不改变出库状态。 */
function downloadSelectedEmails() {
  if (actionBusy) return;
  const emails = [...new Set(selectedFor('email').map(id => adobeCache[id].email.trim()))];
  if (!emails.length) return toast(ACTION_REASON.email, true);
  const blob = new Blob([emails.join('\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'adobe_emails_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 ' + emails.length + ' 个邮箱');
}

/* ===== 导出 Cookie（string 字符串 / json 对象 / array 批量数组；导出即出库） ===== */
async function downloadAdobe(id, format) {
  if (!canAdobeAction(adobeCache[id], 'session')) return toast(ACTION_REASON.session, true);
  return performAction(() => downloadByIds([id], format));
}
async function downloadSelected(format) {
  const ids = selectedFor('session');
  if (!ids.length) return toast(ACTION_REASON.session, true);
  return performAction(() => downloadByIds(ids, format));
}
/* 一键导出全部"已注册未出库"，无需先勾选。 */
async function downloadUnshipped(format) {
  return performAction(() => downloadByIds([], format, true));
}
async function downloadByIds(ids, format, unshippedOnly) {
  const r = await api('/api/adobe/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, format, unshipped_only: !!unshippedOnly }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    return toast(d.error || '导出失败', true);
  }
  const blob = await r.blob();
  const disposition = r.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const fallback = format === 'array' ? 'adobe_cookies_array.json'
    : format === 'json' ? 'adobe_cookies.json' : 'adobe_cookies.txt';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = match ? match[1] : fallback;
  a.click();
  URL.revokeObjectURL(a.href);
  load();
}

/* ===== 删除 ===== */
function delSelected() { return runSelected('delete', '', '删除', 'DELETE'); }
function del(id) {
  if (!confirm('确定删除 Adobe 账号 #' + id + '？')) return;
  return performAction(async () => {
    await adobeJSON('/api/adobe/registrations/' + id, { method: 'DELETE' });
    adobeSelected.delete(id);
    toast('已删除');
  });
}
function deleteAllAdobe() {
  if (!confirm('确定删除全部 Adobe 账号记录？此操作不可恢复。')) return;
  if (!confirm('再次确认：将永久删除 Adobe 注册中的全部记录。')) return;
  return performAction(async () => {
    const d = await adobeJSON('/api/adobe/registrations', { method: 'DELETE' });
    adobeSelected.clear();
    page = 1;
    toast('已删除 ' + (d.deleted || 0) + ' 个 Adobe 账号');
  });
}

/* ===== 日志 ===== */
async function showLog(id) {
  logId = id;
  document.getElementById('log-title').textContent = '执行日志';
  document.getElementById('log-body').textContent = '加载中...';
  document.getElementById('log-shot-btn').style.display = 'none';
  document.getElementById('log-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  clearInterval(logTimer);
  await refreshLog(false);
  logTimer = setInterval(() => refreshLog(true), 2000);
}
async function refreshLog(silent) {
  if (logId == null) return;
  const id = logId;
  try {
    const d = await adobeJSON('/api/adobe/registrations/' + id + '/logs');
    if (logId !== id) return;
    document.getElementById('log-title').textContent = '执行日志 · ' + d.email;
    document.getElementById('log-shot-btn').style.display = d.has_shot ? '' : 'none';
    document.getElementById('log-body').textContent = (d.note ? '备注: ' + d.note + '\n\n' : '') + (d.log || '（无执行日志）');
  } catch (error) { if (!silent) toast('读取日志失败：' + error.message, true); }
}
function closeLog() {
  clearInterval(logTimer);
  logTimer = null;
  logId = null;
  document.getElementById('log-modal').style.display = 'none';
  document.body.style.overflow = '';
}

/* ===== 异常截图 ===== */
async function viewShot() {
  if (logId == null) return;
  const r = await api('/api/adobe/registrations/' + logId + '/shot');
  if (!r.ok) return toast('暂无异常截图', true);
  const blob = await r.blob();
  const img = document.getElementById('shot-img');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.src = img.dataset.url = URL.createObjectURL(blob);
  document.getElementById('shot-modal').style.display = 'flex';
}
function closeShot() {
  document.getElementById('shot-modal').style.display = 'none';
}

/* ===== 测活（手动，仅点击触发；只标状态不删号；unknown 不判死） ===== */
const LIVE_BASE = '/api/adobe/registrations';
const ALIVE_LABEL = { alive: '有效', dead: '失效', unknown: '未知' };
let liveTimer = null;
function aliveCell(x) {
  if (!x.alive) return '<span class="badge pending" title="尚未测活">未测</span>';
  const cls = x.alive === 'alive' ? 'registered' : (x.alive === 'dead' ? 'register_failed' : 'pending');
  const t = x.alive_checked_at ? '最近检测: ' + fmtTime(x.alive_checked_at) : '';
  return `<span class="badge ${cls}" title="${t}">${ALIVE_LABEL[x.alive] || esc(x.alive)}</span>`;
}
function liveCheckOne(id) {
  if (!canAdobeAction(adobeCache[id], 'session')) return toast(ACTION_REASON.session, true);
  return performAction(async () => {
    toast('正在测活 #' + id + ' ...');
    const d = await adobePost(LIVE_BASE + '/' + id + '/livecheck');
    toast('测活完成: ' + (ALIVE_LABEL[d.alive] || d.alive));
  });
}
function liveCheckAll() {
  if (!confirm('对全部已注册且有会话的账号执行测活？')) return;
  return startLiveCheck([]);
}
function liveCheckSelected() {
  const ids = selectedFor('session');
  if (!ids.length) return toast(ACTION_REASON.session, true);
  return startLiveCheck(ids);
}
function startLiveCheck(ids) {
  return performAction(async () => {
    const d = await adobePost(LIVE_BASE + '/livecheck', { ids });
    toast('已开始测活 ' + (d.total || 0) + ' 个账号');
    pollLive();
  });
}
function pollLive() {
  clearInterval(liveTimer);
  const el = document.getElementById('live-progress');
  const tick = async () => {
    try {
      const s = await adobeJSON(LIVE_BASE + '/livecheck/status');
      if (el && (s.running || s.done)) {
        el.style.display = '';
        const summary = `有效 ${s.alive} · 失效 ${s.dead} · 未知 ${s.unknown}`;
        el.textContent = s.running ? `测活中 ${s.done}/${s.total} · ${summary}` : `测活完成 · ${summary}`;
        if (!s.running) setTimeout(() => { if (el) el.style.display = 'none'; }, 8000);
      }
      if (!s.running) { clearInterval(liveTimer); load(); }
    } catch (e) { /* ignore */ }
  };
  tick();
  liveTimer = setInterval(tick, 1500);
}

/* ===== 救回（还原会话→自动过 ride 身份核验→重采会话；不删号） ===== */
function rescueOne(id) {
  if (!canAdobeAction(adobeCache[id], 'rescue')) return toast(ACTION_REASON.rescue, true);
  return performAction(async () => {
    await adobePost(LIVE_BASE + '/' + id + '/rescue');
    toast('已开始救回 #' + id + '，进度见日志');
  });
}
function rescueSelected() { return runSelected('rescue', 'rescue', '启动救回'); }
function rescueDead() {
  if (!confirm('对全部已注册、失效且有会话的账号执行救回？')) return;
  return performAction(async () => {
    const d = await adobePost(LIVE_BASE + '/rescue-dead');
    toast(d.started ? '已开始批量救回 ' + d.started + ' 个失效号' : '没有符合条件的失效账号', !d.started);
  });
}

document.getElementById('search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { page = 1; load(); }
});
document.getElementById('filter-status').addEventListener('change', () => { page = 1; load(); });

load();
loadProduce();
loadBrowserGate();
loadAdobeBrowserMode();
pollLive();
setInterval(load, 3000);
setInterval(loadProduce, 2000);
setInterval(loadBrowserGate, 2500);
