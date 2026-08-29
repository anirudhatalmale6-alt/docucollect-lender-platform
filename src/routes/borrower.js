import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool, audit } from '../lib/db.js';

const r = Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_r, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname))
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_r, file, cb) => cb(null, ALLOWED.has(file.mimetype))
});

// Resolve a request purely from its unguessable token. No lender auth here.
async function loadByToken(token) {
  return (await pool.query(`SELECT * FROM requests WHERE access_token=$1 LIMIT 1`, [token])).rows[0];
}

// Lightweight signature-based scan stand-in. Real deployment shells to ClamAV
// (clamdscan) and only flips scan_status to 'clean' on a clean result.
function scanFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR';
  return buf.includes(EICAR) ? 'infected' : 'clean';
}

// Borrower opens the link — returns org branding + whether OTP is needed.
r.get('/:token', async (req, res) => {
  const rq = await loadByToken(req.params.token);
  if (!rq) return res.status(404).json({ error: 'invalid_link' });
  const org = (await pool.query(`SELECT name, brand_color FROM orgs WHERE id=$1`, [rq.org_id])).rows[0];
  const cust = (await pool.query(`SELECT full_name FROM customers WHERE id=$1`, [rq.customer_id])).rows[0];
  res.json({
    org, customer_name: cust.full_name, title: rq.title, status: rq.status,
    due_date: rq.due_date, otp_verified: rq.otp_verified
  });
});

// Identity verification via the one-time code the lender shared out-of-band.
r.post('/:token/verify', async (req, res) => {
  const rq = await loadByToken(req.params.token);
  if (!rq) return res.status(404).json({ error: 'invalid_link' });
  if (String(req.body.code || '').trim() !== rq.otp_code)
    return res.status(401).json({ error: 'bad_code' });
  await pool.query(`UPDATE requests SET otp_verified=true WHERE id=$1`, [rq.id]);
  await audit(rq.org_id, `borrower:${req.params.token.slice(0, 6)}`, 'borrower.verified', rq.id, null, req.ip);
  res.json({ ok: true });
});

// Checklist for the borrower (only after OTP)
r.get('/:token/items', async (req, res) => {
  const rq = await loadByToken(req.params.token);
  if (!rq) return res.status(404).json({ error: 'invalid_link' });
  if (!rq.otp_verified) return res.status(403).json({ error: 'not_verified' });
  const items = (await pool.query(`
    SELECT ri.id, ri.label, ri.hint, ri.required, ri.status, ri.review_note,
      d.filename, d.version, d.uploaded_at
    FROM request_items ri
    LEFT JOIN documents d ON d.item_id=ri.id AND d.is_current=true
    WHERE ri.request_id=$1 ORDER BY ri.sort`, [rq.id])).rows;
  res.json({ title: rq.title, items });
});

// Upload a file for a checklist item. Supersedes any prior version.
r.post('/:token/items/:itemId/upload', upload.single('file'), async (req, res) => {
  const rq = await loadByToken(req.params.token);
  if (!rq) return res.status(404).json({ error: 'invalid_link' });
  if (!rq.otp_verified) return res.status(403).json({ error: 'not_verified' });
  if (!req.file) return res.status(400).json({ error: 'no_file_or_bad_type' });

  const item = (await pool.query(
    `SELECT * FROM request_items WHERE id=$1 AND request_id=$2`,
    [req.params.itemId, rq.id])).rows[0];
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  const buf = fs.readFileSync(req.file.path);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const scan = scanFile(req.file.path);
  if (scan === 'infected') {
    fs.unlinkSync(req.file.path);
    await audit(rq.org_id, `borrower`, 'upload.blocked_malware', item.id, { label: item.label }, req.ip);
    return res.status(422).json({ error: 'malware_detected' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // supersede previous current version
    await client.query(`UPDATE documents SET is_current=false WHERE item_id=$1 AND is_current=true`,
      [item.id]);
    const nextVer = (await client.query(
      `SELECT COALESCE(MAX(version),0)+1 AS v FROM documents WHERE item_id=$1`, [item.id])).rows[0].v;
    const doc = (await client.query(
      `INSERT INTO documents (org_id, item_id, version, filename, stored_path, mime_type, size_bytes, sha256, scan_status, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'clean',true) RETURNING id, version`,
      [rq.org_id, item.id, nextVer, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, sha256]
    )).rows[0];
    await client.query(`UPDATE request_items SET status='uploaded', review_note=NULL WHERE id=$1`, [item.id]);
    await client.query('COMMIT');
    await audit(rq.org_id, `borrower`, 'document.uploaded', item.id,
      { label: item.label, filename: req.file.originalname, version: doc.version, sha256 }, req.ip);
    res.json({ ok: true, version: doc.version, scan_status: 'clean' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'upload_failed' });
  } finally {
    client.release();
  }
});

// Borrower posts a message
r.post('/:token/messages', async (req, res) => {
  const rq = await loadByToken(req.params.token);
  if (!rq || !rq.otp_verified) return res.status(403).json({ error: 'not_verified' });
  const cust = (await pool.query(`SELECT full_name FROM customers WHERE id=$1`, [rq.customer_id])).rows[0];
  const row = (await pool.query(
    `INSERT INTO messages (org_id, request_id, sender, sender_name, body)
     VALUES ($1,$2,'borrower',$3,$4) RETURNING *`,
    [rq.org_id, rq.id, cust.full_name, req.body.body])).rows[0];
  res.json(row);
});

r.get('/:token/messages', async (req, res) => {
  const rq = await loadByToken(req.params.token);
  if (!rq) return res.status(404).json({ error: 'invalid_link' });
  const rows = (await pool.query(
    `SELECT sender, sender_name, body, created_at FROM messages WHERE request_id=$1 ORDER BY created_at`,
    [rq.id])).rows;
  res.json(rows);
});

export default r;
