# DocuCollect — Secure Document Collection for Lenders

A working demo slice of a B2B SaaS document-collection platform for lenders and
financial-services firms (a modern alternative to FileInvite, with lender-specific
checklists and workflows).

This is a **proof-of-concept build** created to demonstrate the core end-to-end
flow on real code + PostgreSQL. It is intentionally focused — it implements the
spine of the product so you can see the actual working software, not a mockup.

## What works in this build

**Lender side**
- Organization signup (multi-tenant) with an owner account and brand colour
- Email/password login, JWT session in an HttpOnly cookie
- Role-based permissions (owner / admin / agent / viewer)
- Customer management
- Reusable document-checklist templates
- Create a secure, branded document request from a checklist
- Dashboard with per-request progress rollup
- Review each uploaded document: accept, or reject with a note (reopens for re-upload)
- Two-way messaging with the borrower
- Immutable audit log of every action

**Borrower side (mobile-first)**
- Opens via an unguessable secure link — no account needed
- Identity verification with a one-time code
- Branded checklist of required documents
- Upload from desktop **or take a photo on a phone** (`capture="environment"`)
- Sees status per item (pending / uploaded / accepted / rejected) and re-upload notes
- Messaging with the lender

**Security & files**
- Strict tenant isolation — every query is scoped by `org_id`; a second org gets
  404 / empty results on another org's data (verified)
- Passwords hashed with bcrypt
- File uploads: type allow-list (JPEG/PNG/HEIC/WebP/PDF), 25 MB cap
- SHA-256 recorded per file; **document versioning** (a rejected upload is superseded,
  not overwritten — full history retained)
- Malware scan hook — EICAR test file is detected and blocked. In production this
  shells out to ClamAV (`clamdscan`); the hook is already wired in.
- Basic security headers (nosniff, X-Frame-Options, Referrer-Policy)

## Tech stack

- Node.js + Express (ES modules)
- PostgreSQL 16 (schema in `db/schema.sql`)
- Vanilla JS frontends (no build step) — lender console + borrower portal
- bcryptjs, jsonwebtoken, multer, nanoid

## Run it locally

```bash
# 1. PostgreSQL
createdb docucollect
psql -d docucollect -f db/schema.sql

# 2. Config
cp .env.example .env      # edit DATABASE_URL + JWT_SECRET

# 3. Install & start
npm install
npm start                 # http://localhost:4600
```

- Lender console:  `http://localhost:4600/app`
- Borrower portal: opened via the secure link the lender generates

## Roadmap to full product (not in this demo slice)

Payment/subscription (Stripe) with plan gating, email/SMS delivery of links + codes,
document preview/thumbnails, S3-compatible object storage with server-side encryption,
Postgres row-level security policies, the AI layer (auto-classify uploaded docs, extract
key fields, flag mismatches), and VPS deployment with CI. Happy to walk through the plan.
