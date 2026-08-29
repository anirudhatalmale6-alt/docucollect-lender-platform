import { Router } from 'express';
import { customAlphabet } from 'nanoid';
import { pool, tenantQuery, audit } from '../lib/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const r = Router();
r.use(requireAuth);

const linkToken = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz', 32);
const otp = customAlphabet('0123456789', 6);

// ---- Customers ----
r.get('/customers', async (req, res) => {
  const rows = (await tenantQuery(req.user.org_id,
    `SELECT * FROM customers WHERE org_id=$1 ORDER BY created_at DESC`)).rows;
  res.json(rows);
});

r.post('/customers', requireRole('agent'), async (req, res) => {
  const { full_name, email, phone } = req.body;
  if (!full_name || !email) return res.status(400).json({ error: 'missing_fields' });
  const row = (await tenantQuery(req.user.org_id,
    `INSERT INTO customers (org_id, full_name, email, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
    [full_name, email, phone || null])).rows[0];
  await audit(req.user.org_id, req.user.email, 'customer.created', row.id, { full_name }, req.ip);
  res.json(row);
});

// ---- Templates ----
r.get('/templates', async (req, res) => {
  const rows = (await tenantQuery(req.user.org_id,
    `SELECT * FROM templates WHERE org_id=$1 ORDER BY created_at DESC`)).rows;
  res.json(rows);
});

r.post('/templates', requireRole('agent'), async (req, res) => {
  const { name, items } = req.body;
  if (!name || !Array.isArray(items)) return res.status(400).json({ error: 'missing_fields' });
  const row = (await tenantQuery(req.user.org_id,
    `INSERT INTO templates (org_id, name, items) VALUES ($1,$2,$3) RETURNING *`,
    [name, JSON.stringify(items)])).rows[0];
  await audit(req.user.org_id, req.user.email, 'template.created', row.id, { name }, req.ip);
  res.json(row);
});

// ---- Requests ----
// Create a document request from a template (or ad-hoc items) for a customer.
r.post('/requests', requireRole('agent'), async (req, res) => {
  const { customer_id, title, due_date, items } = req.body;
  if (!customer_id || !title || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'missing_fields' });

  const cust = (await tenantQuery(req.user.org_id,
    `SELECT * FROM customers WHERE org_id=$1 AND id=$2`, [customer_id])).rows[0];
  if (!cust) return res.status(404).json({ error: 'customer_not_found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const token = linkToken();
    const code = otp();
    const request = (await client.query(
      `INSERT INTO requests (org_id, customer_id, title, access_token, otp_code, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.org_id, customer_id, title, token, code, due_date || null, req.user.uid]
    )).rows[0];

    let sort = 0;
    for (const it of items) {
      await client.query(
        `INSERT INTO request_items (org_id, request_id, label, hint, required, sort)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user.org_id, request.id, it.label, it.hint || null, it.required !== false, sort++]
      );
    }
    await client.query('COMMIT');
    await audit(req.user.org_id, req.user.email, 'request.created', request.id,
      { title, customer: cust.full_name, items: items.length }, req.ip);
    // In production the link + OTP are delivered by branded email/SMS. For the
    // demo we return them so you can open the borrower portal directly.
    res.json({ request, borrower_link: `/b/${token}`, otp_code: code });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'request_failed' });
  } finally {
    client.release();
  }
});

// List requests with progress rollup
r.get('/requests', async (req, res) => {
  const rows = (await tenantQuery(req.user.org_id, `
    SELECT rq.*, c.full_name AS customer_name, c.email AS customer_email,
      (SELECT count(*) FROM request_items ri WHERE ri.request_id=rq.id) AS total_items,
      (SELECT count(*) FROM request_items ri WHERE ri.request_id=rq.id AND ri.status='accepted') AS accepted_items
    FROM requests rq JOIN customers c ON c.id=rq.customer_id
    WHERE rq.org_id=$1 ORDER BY rq.created_at DESC`)).rows;
  res.json(rows);
});

// Full request detail: items + current document per item
r.get('/requests/:id', async (req, res) => {
  const rq = (await tenantQuery(req.user.org_id,
    `SELECT rq.*, c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
     FROM requests rq JOIN customers c ON c.id=rq.customer_id
     WHERE rq.org_id=$1 AND rq.id=$2`, [req.params.id])).rows[0];
  if (!rq) return res.status(404).json({ error: 'not_found' });
  const items = (await tenantQuery(req.user.org_id, `
    SELECT ri.*,
      d.id AS doc_id, d.filename, d.mime_type, d.size_bytes, d.version, d.scan_status, d.uploaded_at
    FROM request_items ri
    LEFT JOIN documents d ON d.item_id=ri.id AND d.is_current=true
    WHERE ri.org_id=$1 AND ri.request_id=$2 ORDER BY ri.sort`, [req.params.id])).rows;
  const messages = (await tenantQuery(req.user.org_id,
    `SELECT sender, sender_name, body, created_at FROM messages
     WHERE org_id=$1 AND request_id=$2 ORDER BY created_at`, [req.params.id])).rows;
  res.json({ request: rq, items, messages, borrower_link: `/b/${rq.access_token}`, otp_code: rq.otp_code });
});

// Review a document: accept / reject (rejection reopens the item for re-upload)
r.post('/items/:itemId/review', requireRole('agent'), async (req, res) => {
  const { decision, note } = req.body; // 'accept' | 'reject'
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  const item = (await tenantQuery(req.user.org_id,
    `UPDATE request_items SET status=$3, review_note=$4
     WHERE org_id=$1 AND id=$2 RETURNING *`,
    [req.params.itemId, status, note || null])).rows[0];
  if (!item) return res.status(404).json({ error: 'not_found' });
  await audit(req.user.org_id, req.user.email, `document.${decision}`, item.id,
    { label: item.label, note }, req.ip);

  // Auto-complete the request when every item is accepted.
  const pending = (await tenantQuery(req.user.org_id,
    `SELECT count(*) FROM request_items WHERE org_id=$1 AND request_id=$2 AND status<>'accepted'`,
    [item.request_id])).rows[0].count;
  if (Number(pending) === 0) {
    await tenantQuery(req.user.org_id,
      `UPDATE requests SET status='completed' WHERE org_id=$1 AND id=$2`, [item.request_id]);
  }
  res.json(item);
});

// Lender posts a message to the borrower
r.post('/requests/:id/messages', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'empty' });
  const row = (await tenantQuery(req.user.org_id,
    `INSERT INTO messages (org_id, request_id, sender, sender_name, body)
     VALUES ($1,$2,'lender',$3,$4) RETURNING *`,
    [req.params.id, req.user.name, body])).rows[0];
  res.json(row);
});

// Audit log view
r.get('/audit', async (req, res) => {
  const rows = (await tenantQuery(req.user.org_id,
    `SELECT actor, action, target, detail, created_at FROM audit_log
     WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`)).rows;
  res.json(rows);
});

export default r;
