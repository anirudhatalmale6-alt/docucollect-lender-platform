import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import lenderRoutes from './routes/lender.js';
import borrowerRoutes from './routes/borrower.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(cookieParser());

// Basic security headers (helmet-equivalent minimal set for the demo)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/b', borrowerRoutes);    // token-based borrower endpoints (must precede lender catch-all)
app.use('/api', lenderRoutes);        // lender-authenticated endpoints

// Static frontends
app.use('/', express.static(path.join(__dirname, '../public')));
app.get('/app', (_r, res) => res.sendFile(path.join(__dirname, '../public/lender/index.html')));
app.get('/b/:token', (_r, res) => res.sendFile(path.join(__dirname, '../public/borrower/index.html')));

app.get('/health', (_r, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4600;
app.listen(PORT, () => console.log(`DocuCollect running on :${PORT}`));
