-- DocuCollect — secure document collection platform for lenders
-- Multi-tenant schema. Every tenant-owned row carries org_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenants (lender organizations)
CREATE TABLE IF NOT EXISTS orgs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  brand_color   text NOT NULL DEFAULT '#2563eb',
  plan          text NOT NULL DEFAULT 'trial',      -- trial | starter | pro
  plan_status   text NOT NULL DEFAULT 'active',     -- active | past_due | canceled
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Lender-side users, scoped to an org, with a role
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  role          text NOT NULL DEFAULT 'agent',      -- owner | admin | agent | viewer
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

-- Borrowers / customers of a lender
CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  email         text NOT NULL,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Reusable document checklist templates per org
CREATE TABLE IF NOT EXISTS templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          text NOT NULL,
  items         jsonb NOT NULL DEFAULT '[]',         -- [{label, required, hint}]
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A document request sent to a borrower (secure branded link)
CREATE TABLE IF NOT EXISTS requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'open',        -- open | completed | canceled
  access_token  text NOT NULL UNIQUE,                -- unguessable link token
  otp_code      text,                                -- borrower identity verification
  otp_verified  boolean NOT NULL DEFAULT false,
  due_date      date,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Individual checklist line items on a request
CREATE TABLE IF NOT EXISTS request_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  label         text NOT NULL,
  hint          text,
  required      boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'pending',     -- pending | uploaded | accepted | rejected
  review_note   text,
  sort          int NOT NULL DEFAULT 0
);

-- Uploaded files, versioned per item (a rejected upload is superseded, not deleted)
CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES request_items(id) ON DELETE CASCADE,
  version       int NOT NULL DEFAULT 1,
  filename      text NOT NULL,
  stored_path   text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  scan_status   text NOT NULL DEFAULT 'pending',     -- pending | clean | infected
  is_current    boolean NOT NULL DEFAULT true,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- Two-way messages on a request
CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  sender        text NOT NULL,                       -- 'lender' | 'borrower'
  sender_name   text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Immutable audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  org_id        uuid REFERENCES orgs(id) ON DELETE CASCADE,
  actor         text NOT NULL,                       -- user email or 'borrower:<name>'
  action        text NOT NULL,
  target        text,
  detail        jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_org   ON customers(org_id);
CREATE INDEX IF NOT EXISTS idx_requests_org    ON requests(org_id);
CREATE INDEX IF NOT EXISTS idx_reqitems_req    ON request_items(request_id);
CREATE INDEX IF NOT EXISTS idx_documents_item  ON documents(item_id);
CREATE INDEX IF NOT EXISTS idx_audit_org       ON audit_log(org_id, created_at DESC);
