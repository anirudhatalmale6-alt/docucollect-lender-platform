import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;

export function sign(user) {
  return jwt.sign(
    { uid: user.id, org_id: user.org_id, email: user.email, role: user.role, name: user.full_name },
    SECRET,
    { expiresIn: '12h' }
  );
}

// Lender-side auth: requires a valid JWT cookie, attaches req.user (with org_id).
export function requireAuth(req, res, next) {
  const token = req.cookies?.dc_token;
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Role gate. Roles are ordered; a higher role satisfies a lower requirement.
const RANK = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export function requireRole(min) {
  return (req, res, next) => {
    if ((RANK[req.user.role] ?? -1) < RANK[min]) {
      return res.status(403).json({ error: 'insufficient_role', need: min });
    }
    next();
  };
}
