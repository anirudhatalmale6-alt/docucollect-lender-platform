import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, audit } from '../lib/db.js';
import { sign, requireAuth } from '../middleware/auth.js';

const r = Router();

// Org signup: creates the tenant + its first owner user in one transaction.
r.post('/signup', async (req, res) => {
  const { org_name, full_name, email, password, brand_color } = req.body;
  if (!org_name || !full_name || !email || !password)
    return res.status(400).json({ error: 'missing_fields' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = (await client.query(
      `INSERT INTO orgs (name, brand_color) VALUES ($1, COALESCE($2,'#2563eb')) RETURNING *`,
      [org_name, brand_color]
    )).rows[0];
    const hash = await bcrypt.hash(password, 10);
    const user = (await client.query(
      `INSERT INTO users (org_id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING *`,
      [org.id, email.toLowerCase(), hash, full_name]
    )).rows[0];
    await client.query('COMMIT');
    await audit(org.id, email.toLowerCase(), 'org.created', org.id, { org_name }, req.ip);
    res.cookie('dc_token', sign(user), { httpOnly: true, sameSite: 'lax' });
    res.json({ org, user: { id: user.id, email: user.email, role: user.role, name: user.full_name } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    console.error(e);
    res.status(500).json({ error: 'signup_failed' });
  } finally {
    client.release();
  }
});

r.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = (await pool.query(
    `SELECT * FROM users WHERE email=$1 LIMIT 1`, [String(email || '').toLowerCase()]
  )).rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash)))
    return res.status(401).json({ error: 'bad_credentials' });
  await audit(user.org_id, user.email, 'user.login', user.id, null, req.ip);
  res.cookie('dc_token', sign(user), { httpOnly: true, sameSite: 'lax' });
  res.json({ user: { id: user.id, email: user.email, role: user.role, name: user.full_name } });
});

r.post('/logout', (req, res) => { res.clearCookie('dc_token'); res.json({ ok: true }); });

r.get('/me', requireAuth, async (req, res) => {
  const org = (await pool.query(`SELECT id,name,brand_color,plan,plan_status FROM orgs WHERE id=$1`,
    [req.user.org_id])).rows[0];
  res.json({ user: req.user, org });
});

export default r;
