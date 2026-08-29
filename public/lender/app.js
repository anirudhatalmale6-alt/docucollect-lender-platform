const $ = id => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: res.statusText }));
  return res.json();
};

let ORG = null;
let TEMPLATES = [];

function showAuth(which) {
  $('tabLogin').classList.toggle('active', which === 'login');
  $('tabSignup').classList.toggle('active', which === 'signup');
  $('loginForm').classList.toggle('hide', which !== 'login');
  $('signupForm').classList.toggle('hide', which !== 'signup');
}
function toggle(id) { $(id).classList.toggle('hide'); }

async function signup() {
  try {
    await api('/auth/signup', { method: 'POST', body: JSON.stringify({
      org_name: $('su_org').value, brand_color: $('su_color').value,
      full_name: $('su_name').value, email: $('su_email').value, password: $('su_pass').value }) });
    await boot();
  } catch (e) { $('authErr').textContent = e.error || 'Signup failed'; }
}
async function login() {
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({
      email: $('li_email').value, password: $('li_pass').value }) });
    await boot();
  } catch (e) { $('authErr').textContent = 'Invalid credentials'; }
}
async function logout() { await api('/auth/logout', { method: 'POST' }); location.reload(); }

async function boot() {
  let me;
  try { me = await api('/auth/me'); } catch { return; }
  ORG = me.org;
  document.documentElement.style.setProperty('--brand', ORG.brand_color);
  $('who').textContent = `${me.user.name} · ${ORG.name} · ${me.user.role}`;
  $('authView').classList.add('hide');
  $('appView').classList.remove('hide');
  await refreshCustomers();
  await refreshTemplates();
  await view('requests');
}

async function refreshCustomers() {
  const cs = await api('/customers');
  $('rq_customer').innerHTML = cs.map(c => `<option value="${c.id}">${c.full_name} — ${c.email}</option>`).join('')
    || '<option value="">(add a customer first)</option>';
}
async function refreshTemplates() {
  TEMPLATES = await api('/templates');
  $('rq_template').innerHTML = '<option value="">— none —</option>' +
    TEMPLATES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');
}
function loadTemplateItems() {
  const idx = $('rq_template').value;
  if (idx === '') return;
  const t = TEMPLATES[idx];
  $('rq_items').value = (t.items || []).map(x => x.label).join('\n');
}

async function addCustomer() {
  try {
    await api('/customers', { method: 'POST', body: JSON.stringify({
      full_name: $('nc_name').value, email: $('nc_email').value, phone: $('nc_phone').value }) });
    $('nc_name').value = $('nc_email').value = $('nc_phone').value = '';
    toggle('newCustomer');
    await refreshCustomers();
  } catch (e) { alert(e.error || 'Failed'); }
}

async function createRequest() {
  const items = $('rq_items').value.split('\n').map(s => s.trim()).filter(Boolean)
    .map(label => ({ label, required: true }));
  if (!$('rq_customer').value || !$('rq_title').value || !items.length)
    return alert('Pick a customer, add a title and at least one checklist item.');
  try {
    const out = await api('/requests', { method: 'POST', body: JSON.stringify({
      customer_id: $('rq_customer').value, title: $('rq_title').value,
      due_date: $('rq_due').value || null, items }) });
    const url = location.origin + out.borrower_link;
    $('createdLinkText').textContent = url;
    $('createdOtp').textContent = out.otp_code;
    $('createdOpen').href = out.borrower_link;
    $('createdLink').classList.remove('hide');
    $('rq_title').value = $('rq_items').value = '';
    await view('requests');
  } catch (e) { alert(e.error || 'Failed'); }
}

function show(v) { ['requestsView', 'detailView', 'auditView'].forEach(x => $(x).classList.add('hide')); $(v).classList.remove('hide'); }

async function view(which) {
  if (which === 'requests') {
    show('requestsView');
    const rows = await api('/requests');
    $('requestsBody').innerHTML = rows.map(r => {
      const pct = r.total_items > 0 ? Math.round(100 * r.accepted_items / r.total_items) : 0;
      return `<tr>
        <td>${r.customer_name}</td>
        <td>${r.title}</td>
        <td style="min-width:130px"><div class="bar"><i style="width:${pct}%"></i></div>
          <span class="muted">${r.accepted_items}/${r.total_items} accepted</span></td>
        <td><span class="pill p-${r.status}">${r.status}</span></td>
        <td><button class="sm" onclick="openDetail('${r.id}')">Open</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No requests yet.</td></tr>';
  } else if (which === 'audit') {
    show('auditView');
    const rows = await api('/audit');
    $('auditBody').innerHTML = rows.map(a => `<tr>
      <td class="muted">${new Date(a.created_at).toLocaleString()}</td>
      <td>${a.actor}</td><td><b>${a.action}</b></td>
      <td class="muted">${a.detail ? JSON.stringify(a.detail) : ''}</td></tr>`).join('');
  }
}

async function openDetail(id) {
  const d = await api('/requests/' + id);
  show('detailView');
  const url = location.origin + d.borrower_link;
  const itemsHtml = d.items.map(it => `
    <div class="item">
      <div class="row" style="justify-content:space-between">
        <b>${it.label}</b> <span class="pill p-${it.status}">${it.status}</span>
      </div>
      ${it.hint ? `<div class="muted">${it.hint}</div>` : ''}
      ${it.filename ? `<div class="muted">📎 ${it.filename} · v${it.version} · scan: ${it.scan_status}
         · <a href="#" onclick="return false">${(it.size_bytes/1024).toFixed(0)} KB</a></div>` : '<div class="muted">No file uploaded yet.</div>'}
      ${it.review_note ? `<div class="muted">Note: ${it.review_note}</div>` : ''}
      ${it.status === 'uploaded' ? `<div class="row" style="margin-top:8px">
          <button class="sm ok" onclick="review('${id}','${it.id}','accept')">Accept</button>
          <button class="sm bad" onclick="review('${id}','${it.id}','reject')">Request replacement</button>
        </div>` : ''}
    </div>`).join('');
  const msgHtml = d.messages.map(m => `<div class="muted"><b>${m.sender_name}</b> (${m.sender}): ${m.body}</div>`).join('') || '<span class="muted">No messages.</span>';
  $('detailView').innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${d.request.title}</h2>
      <button class="ghost sm" onclick="view('requests')">← Back</button>
    </div>
    <div class="muted">${d.request.customer_name} · ${d.request.customer_email} · status
      <span class="pill p-${d.request.status}">${d.request.status}</span></div>
    <div class="linkbox">Borrower link: ${url}<br>Identity code: <b>${d.otp_code}</b></div>
    <div>${itemsHtml}</div>
    <div class="card" style="background:#f8fafc">
      <h2>Messages</h2>
      <div id="msgs" class="stack">${msgHtml}</div>
      <div class="row" style="margin-top:8px">
        <input id="msgBody" placeholder="Message the borrower…" style="margin:0">
        <button class="sm" onclick="sendMsg('${id}')">Send</button>
      </div>
    </div>`;
}

async function review(reqId, itemId, decision) {
  let note = null;
  if (decision === 'reject') { note = prompt('Reason / what to re-upload:') || 'Please re-upload a clearer copy.'; }
  await api('/items/' + itemId + '/review', { method: 'POST', body: JSON.stringify({ decision, note }) });
  await openDetail(reqId);
}
async function sendMsg(reqId) {
  const body = $('msgBody').value.trim();
  if (!body) return;
  await api('/requests/' + reqId + '/messages', { method: 'POST', body: JSON.stringify({ body }) });
  await openDetail(reqId);
}

boot();
