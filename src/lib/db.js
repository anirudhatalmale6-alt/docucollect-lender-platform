import pg from 'pg';
import 'dotenv/config';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const q = (text, params) => pool.query(text, params);

// Every tenant query goes through here so org_id scoping is never forgotten.
export async function tenantQuery(orgId, text, params = []) {
  // orgId is always bound as $1; callers write $2, $3, ... for the rest.
  return pool.query(text, [orgId, ...params]);
}

export async function audit(orgId, actor, action, target, detail, ip) {
  await pool.query(
    `INSERT INTO audit_log (org_id, actor, action, target, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, actor, action, target || null, detail ? JSON.stringify(detail) : null, ip || null]
  );
}
