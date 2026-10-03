'use strict';

/* ============================================================
   FinLoop — Server Penjaga
   Support: Localhost + Vercel Serverless
   ============================================================ */

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

const {
  PORT = 3000,
  CLIENT_KEY,
  APPS_SCRIPT_URL,
  SERVER_SECRET,
  ALLOWED_ORIGINS = '',
  RESEND_API_KEY,
  RESEND_FROM = 'FinLoop <noreply@finloop.my.id>'
} = process.env;

const allowedOrigins = ALLOWED_ORIGINS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ---------- helpers ---------- */
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

function send404(res) {
  res.status(404).type('html').send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<title>404 Not Found</title>' +
    '<style>body{font-family:sans-serif;background:#fafafa;color:#333;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    '.box{text-align:center}h1{font-size:48px;margin:0;color:#888}' +
    'p{color:#999}</style></head><body><div class="box">' +
    '<h1>404</h1><p>This page could not be found.</p>' +
    '</div></body></html>'
  );
}

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-FinLoop-Key, X-FinLoop-Action');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ============================================================
   KIRIM EMAIL OTP VIA RESEND
   ============================================================ */
async function sendOtpEmailViaResend(toEmail, otpCode) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY belum diset di .env');
  }

  const html =
    '<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;">' +
      '<h2 style="color:#2563eb;">FinLoop</h2>' +
      '<p>Kode verifikasi kamu:</p>' +
      '<div style="font-size:32px;font-weight:800;letter-spacing:8px;' +
        'color:#18181b;background:#eff6ff;padding:16px;' +
        'border-radius:10px;text-align:center;">' +
        otpCode +
      '</div>' +
      '<p style="color:#6b7280;font-size:13px;margin-top:16px;">' +
        'Kode berlaku 5 menit. Jangan bagikan ke siapa pun.' +
      '</p>' +
    '</div>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [toEmail],
      subject: 'Kode Verifikasi OTP — FinLoop',
      html: html
    })
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error('Resend error ' + res.status + ': ' + text);
  }
  return true;
}

/* ============================================================
   ENDPOINT API
   ============================================================ */
app.post('/api/v1/finloop', async (req, res) => {
  try {
    const clientKey = req.headers['x-finloop-key'];
    if (!CLIENT_KEY || clientKey !== CLIENT_KEY) {
      return send404(res);
    }

    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      return send404(res);
    }

    const body = req.body || {};
    const action = String(body.action || '').trim();
    if (!action) {
      return res.status(400).json({ ok: false, error: 'Action wajib.' });
    }

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (k === 'action') continue;
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    params.set('action', action);
    params.set('_secret', SERVER_SECRET || '');
    params.set('_t', String(Date.now()));

    const url = APPS_SCRIPT_URL +
      (APPS_SCRIPT_URL.includes('?') ? '&' : '?') +
      params.toString();

    const upstream = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store'
    });

    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      console.error('[upstream] Non-JSON:', text.slice(0, 200));
      return res.status(502).json({ ok: false, error: 'Apps Script balas non-JSON.' });
    }

    if (action === 'sendOtp') {
      if (!json.ok) return res.status(200).json(json);
      const otpCode = json.data && json.data.code;
      if (!otpCode) {
        return res.status(500).json({ ok: false, error: 'Kode OTP tidak diterima.' });
      }
      try {
        await sendOtpEmailViaResend(body.email, otpCode);
      } catch (err) {
        console.error('[resend]', err.message);
        return res.status(500).json({ ok: false, error: 'Gagal kirim email OTP.' });
      }
      delete json.data.code;
      return res.status(200).json(json);
    }

    return res.status(200).json(json);

  } catch (err) {
    console.error('[error]', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* ============================================================
   STATIC FILES (gambar tetap di private/assets)
   ============================================================ */
app.use('/private-assets', express.static(path.join(__dirname, 'assets')));

/* ---------- OPTIONS preflight ---------- */
app.options('/api/v1/finloop', (req, res) => res.sendStatus(204));

/* ---------- 404 untuk semua yang lain ---------- */
app.use((req, res) => send404(res));

/* ============================================================
   START
   - Di localhost: app.listen
   - Di Vercel: module.exports (serverless function)
   ============================================================ */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('  FinLoop server running (LOCAL)');
    console.log('  ➜ Buka:    http://localhost:' + PORT);
    console.log('  ➜ API:     POST http://localhost:' + PORT + '/api/v1/finloop');
    console.log('  ➜ Gambar:  http://localhost:' + PORT + '/private-assets/image/*');
    console.log('  ➜ Resend:  ' + (RESEND_API_KEY ? 'aktif' : 'BELUM DISET ⚠️'));
    console.log('');
  });
}

module.exports = app;