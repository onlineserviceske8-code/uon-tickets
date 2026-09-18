// Vercel serverless API - LIVE M-Pesa STK Push via LipaWin
// Callback path: /api/payments/callback  (LipaWin webhook -> confirms & issues tickets)
// Status polling: /api/payments/status/:sessionId

import nodeFetch from 'node-fetch';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

function generateQRCode(data) {
  const qrData = JSON.stringify(data);
  const hash = createHash('sha256').update(qrData).digest('hex').substring(0, 16).toUpperCase();
  return `MADFUN-${hash}`;
}

const TICKET_STYLES = `
  @page { size: 80mm 120mm; margin: 0; }
  body { margin: 0; padding: 20px; font-family: Arial, sans-serif; font-size: 12px; }
  .ticket { border: 2px solid #1a1a2e; border-radius: 8px; padding: 20px; background: #fff; page-break-inside: avoid; }
  .header { text-align: center; border-bottom: 2px solid #1a1a2e; padding-bottom: 15px; margin-bottom: 15px; }
  .logo { font-size: 24px; font-weight: bold; color: #1a1a2e; margin-bottom: 5px; }
  .event-name { font-size: 18px; font-weight: bold; color: #e94560; margin: 10px 0; }
  .details { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 15px 0; }
  .detail-row { display: flex; justify-content: space-between; }
  .label { color: #666; font-size: 11px; }
  .value { font-weight: bold; text-align: right; }
  .qr-section { text-align: center; margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 4px; }
  .qr-code { font-family: monospace; font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #1a1a2e; }
  .footer { text-align: center; font-size: 10px; color: #999; border-top: 1px dashed #ddd; padding-top: 10px; }
  .watermark { position: fixed; bottom: 50px; right: 20px; font-size: 60px; color: rgba(233,69,96,0.05); transform: rotate(-30deg); pointer-events: none; }
  @media print { body { padding: 0 20px; } .ticket { break-inside: avoid; } }
`;

function generateTicketCard(ticket, order, event) {
  return `<div class="ticket">
    <div class="header">
      <div class="logo">🎫 MADFUN TICKET</div>
      <div class="event-name">${event.name}</div>
    </div>
    <div class="details">
      <div class="detail-row"><span class="label">Ticket Type</span><span class="value">${ticket.ticket_type}</span></div>
      <div class="detail-row"><span class="label">Ticket ID</span><span class="value">${ticket.id}</span></div>
      <div class="detail-row"><span class="label">Order #</span><span class="value">${order.orderNumber}</span></div>
      <div class="detail-row"><span class="label">Date</span><span class="value">${new Date(event.date).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
      <div class="detail-row"><span class="label">Time</span><span class="value">${new Date(event.date).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div class="detail-row"><span class="label">Venue</span><span class="value">${event.venue}</span></div>
      <div class="detail-row"><span class="label">Attendee</span><span class="value">${order.customer.name}</span></div>
      <div class="detail-row"><span class="label">Email</span><span class="value">${order.customer.email}</span></div>
    </div>
    <div class="qr-section">
      <div class="qr-code">${ticket.qr_code}</div>
      <div style="font-size: 10px; color: #666; margin-top: 5px;">Present this QR code at entry</div>
    </div>
    <div class="footer">
      <p>This ticket is non-transferable. Valid for one entry only.</p>
      <p>Powered by Madfun • madfun.com</p>
    </div>
  </div>`;
}

function ticketPage(tickets, order, event, title) {
  const cards = tickets.map(t => generateTicketCard(t, order, event)).join('');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>${TICKET_STYLES}</style>
</head>
<body>
  <div class="watermark">MADFUN</div>
  ${cards}
</body></html>`;
}

function generateTicketHTML(ticket, order, event) {
  return ticketPage([ticket], order, event, `Ticket - ${ticket.id}`);
}

function generateTicketsHTML(tickets, order, event) {
  return ticketPage(tickets, order, event, `Tickets - ${order.orderNumber}`);
}

const API_KEY = process.env.LIPAWIN_API_KEY || 'pfx_0b781505379f3b0735972d867e2d66027639bd2e';
const API_EMAIL = process.env.LIPAWIN_EMAIL || 'onlineserviceske8@gmail.com';
const ACCOUNT_NUMBER = process.env.LIPAWIN_ACCOUNT_NUMBER || '0085060049062';
const BUSINESS_ID = process.env.LIPAWIN_BUSINESS_ID || '';
const BUSINESS_CODE = process.env.LIPAWIN_BUSINESS_CODE || '';
const STKPUSH_URL = process.env.LIPAWIN_STKPUSH_URL || 'https://lipawin.com/api/stk_push.php';
const TSTATUS_URL = process.env.LIPAWIN_TSTATUS_URL || 'https://lipawin.com/api/transaction_status.php';
const WEBHOOK_SECRET = process.env.LIPAWIN_WEBHOOK_SECRET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Test/simulation mode. NEVER enabled in production - the Vercel function does
// not set TEST_MODE, so all simulate endpoints return 404 and the real LipaWin
// flow runs exactly as before. Only the local dev-server.js sets it to '1'.
const TEST_MODE = process.env.TEST_MODE === '1';

const EVENT_DATA = {
  id: 'b1011a',
  name: 'University of Nairobi Freshers Night',
  date: '2026-09-18T18:00:00+03:00',
  venue: 'KICC, Nairobi',
  description: "UNSA Freshers Night 2026 - the official welcome party for University of Nairobi's newest students.",
  status: 'published',
  ticketTypes: [
    { id: 'student', name: 'STUDENTS', price: 200, quantity: 200, sold: 0, maxPerOrder: 2, currency: 'KSh' },
    { id: 'regular', name: 'NON-STUDENTS', price: 400, quantity: 500, sold: 0, maxPerOrder: 4, currency: 'KSh' },
    { id: 'vip', name: 'VIP', price: 1000, quantity: 100, sold: 0, maxPerOrder: 2, currency: 'KSh' },
    { id: 'vvip', name: 'VVIP', price: 2000, quantity: 50, sold: 0, maxPerOrder: 2, currency: 'KSh' },
    { id: 'group5', name: 'GROUP OF 5', price: 850, quantity: 50, sold: 0, maxPerOrder: 1, currency: 'KSh' },
    { id: 'group3', name: 'GROUP OF 3', price: 510, quantity: 100, sold: 0, maxPerOrder: 1, currency: 'KSh' },
  ]
};

// ===== Persistent storage (Upstash Redis REST) =====
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to persist across serverless invocations
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || '';
const USE_REDIS = REDIS_URL.startsWith('https');

const store = new Map(); // fallback only for local dev

async function redisRequest(command, ...args) {
  if (!USE_REDIS) return null;
  const url = `${REDIS_URL.replace(/\/$/, '')}/${command}`;
  try {
    const res = await nodeFetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    console.error('Redis error:', e);
    return null;
  }
}

async function getVal(key) {
  if (USE_REDIS) {
    const r = await redisRequest('get', key);
    if (r?.result !== null && r?.result !== undefined) return r.result;
  }
  return store.get(key);
}

async function setVal(key, data, ttl = null) {
  if (USE_REDIS) {
    await redisRequest('set', key, JSON.stringify(data));
    if (ttl) await redisRequest('expire', key, ttl);
  }
  store.set(key, data);
}

async function getOrderById(id) {
  const data = await getVal(`order:${id}`);
  return data ? (typeof data === 'string' ? JSON.parse(data) : data) : null;
}

async function setOrder(order) {
  await setVal(`order:${order.id}`, order, 21600);
  await setVal(`session:${order.sessionId}`, order.id, 21600);
}

async function getOrderBySession(sessionId) {
  const id = await getVal(`session:${sessionId}`);
  return id ? getOrderById(id) : null;
}

async function getPayment(sessionId) {
  const data = await getVal(`payment:${sessionId}`);
  return data ? (typeof data === 'string' ? JSON.parse(data) : data) : null;
}

async function setPayment(p) {
  await setVal(`payment:${p.sessionId}`, p, 21600);
  if (p.transactionRequestId) await setVal(`txn:${p.transactionRequestId}`, p.sessionId, 21600);
}

async function lipawinRequest(url, payload, extraHeaders = {}) {
  try {
    console.log('LipaWin request:', url, JSON.stringify(payload));
    const response = await nodeFetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Accept': 'application/json',
        'X-Api-Key': API_KEY,
        ...extraHeaders
      },
      body: JSON.stringify(payload),
    });
    console.log('LipaWin response status:', response.status);
    const text = await response.text();
    console.log('LipaWin response body:', text);
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    console.error('LipaWin request error:', error);
    return { ok: false, status: 0, data: {}, error: error.message };
  }
}

async function lipawinStkPush(phoneNumber, amount, callbackUrl) {
  const payload = {
    email: API_EMAIL,
    msisdn: phoneNumber,
    amount: Math.round(amount),
    account_number: ACCOUNT_NUMBER,
    business_id: BUSINESS_ID,
    business_code: BUSINESS_CODE,
  };
  if (callbackUrl) payload.callback_url = callbackUrl;
  const extraHeaders = {};
  if (BUSINESS_ID) extraHeaders['X-Business-Id'] = BUSINESS_ID;
  if (BUSINESS_CODE) extraHeaders['X-Business-Code'] = BUSINESS_CODE;
  console.log('LipaWin STK Push payload:', JSON.stringify(payload));
  const res = await lipawinRequest(STKPUSH_URL, payload, extraHeaders);
  console.log('LipaWin STK Push response:', JSON.stringify(res));
  if (!res.ok) {
    return { ok: false, message: `LipaWin error (HTTP ${res.status}): ${res.error || JSON.stringify(res.data)}`, checkoutRequestId: null, transactionRequestId: null };
  }
  const data = res.data;
  const success = data.success === true || data.status === 'success' || data.code === 200 || data.StatusCode === '200';
  if (!success) {
    const msg = data.message || data.error || data.ResponseDescription || 'Payment request rejected by LipaWin';
    console.error('LipaWin STK Push failed:', msg);
    if (msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('balance') || msg.toLowerCase().includes('funds')) {
      return { ok: false, message: `Payment failed. Needs 4 KSh for commission`, checkoutRequestId: null, transactionRequestId: null };
    }
    return { ok: false, message: msg, checkoutRequestId: null, transactionRequestId: null };
  }
  const checkoutRequestId = data.checkout_request_id || data.CheckoutRequestID || data.request_id || data.transaction_id || `LW-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const transactionRequestId = data.transaction_request_id || data.TransactionRequestID || data.transaction_id || data.request_id || checkoutRequestId;
  return { ok: true, message: data.message || data.ResponseDescription || 'STK Push sent', checkoutRequestId, transactionRequestId };
}

async function lipawinCheckStatus(transactionRequestId) {
  if (!transactionRequestId) return { ok: false, status: null, message: 'Missing transaction_request_id' };
  const payload = { email: API_EMAIL, transaction_id: transactionRequestId };
  const res = await lipawinRequest(TSTATUS_URL, payload);
  if (!res.ok) return { ok: false, status: null, message: `LipaWin error (HTTP ${res.status})` };
  const data = res.data;
  const status = String(data.status || data.transaction_status || data.Status || data.State || '').toLowerCase();
  const resultCode = String(data.code || data.result_code || data.ResultCode || data.StatusCode || '');
  const isCompleted =
    data.success === true || data.paid === true || data.isComplete === true ||
    status === 'completed' || status === 'success' || status === 'successful' ||
    status === 'paid' || status === 'confirmed' ||
    resultCode === '200' || resultCode === '0';
  const isFailed =
    status === 'failed' || status === 'cancelled' || status === 'reversed' ||
    status === 'declined' || status === 'abandoned' || status === 'error' ||
    resultCode === '404' || resultCode === '500' || resultCode === '1037';
  if (isCompleted) {
    return { ok: true, status: 'completed', message: data.message || data.result_desc || 'Payment completed' };
  }
  if (isFailed) {
    return { ok: true, status: 'failed', message: data.message || data.result_desc || 'Payment failed' };
  }
  return { ok: true, status: 'pending', message: data.message || 'Payment still pending' };
}

function verifyWebhookSignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true;
  try {
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
    return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (e) {
    return false;
  }
}

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 100;

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  const requests = (rateLimitMap.get(ip) || []).filter(t => t > windowStart);
  if (requests.length >= RATE_LIMIT_MAX) return false;
  requests.push(now);
  rateLimitMap.set(ip, requests);
  return true;
}

function getClientIp(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
    || req.headers.get('x-real-ip') 
    || 'unknown';
}

function validateInput(data, schema) {
  const errors = [];
  for (const [key, rules] of Object.entries(schema)) {
    const value = data[key];
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${key} is required`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (rules.type && typeof value !== rules.type) {
      errors.push(`${key} must be ${rules.type}`);
    }
    if (rules.maxLength && String(value).length > rules.maxLength) {
      errors.push(`${key} exceeds max length ${rules.maxLength}`);
    }
    if (rules.pattern && !rules.pattern.test(value)) {
      errors.push(`${key} format invalid`);
    }
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push(`${key} must be one of: ${rules.enum.join(', ')}`);
    }
  }
  return errors;
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://lipawin.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

async function confirmOrder(order, payment) {
  order.paymentStatus = 'paid';
  order.status = 'confirmed';
  order.paidAt = new Date().toISOString();
  order.tickets = (order.items || []).flatMap(item => {
    return Array.from({ length: item.quantity }, () => {
      const ticketData = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        eventId: order.eventId,
        ticketType: item.name,
        customerEmail: order.customer.email,
        timestamp: Date.now()
      };
      const qrCode = generateQRCode(ticketData);
      return {
        id: `${order.orderNumber}-${Math.random().toString(36).substring(2, 10)}`,
        ticket_type: item.name,
        qr_code: qrCode,
      };
    });
  });
  await setOrder(order);
  if (payment) { payment.status = 'completed'; payment.completedAt = new Date().toISOString(); await setPayment(payment); }
  try { await sendTicketEmail(order, EVENT_DATA); } catch (e) { console.error('Ticket email failed:', e); }
  return order;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Madfun Tickets <onboarding@resend.dev>';
const RESEND_URL = 'https://api.resend.com/emails';

function buildTicketEmailHTML(order, event) {
  const ticketsHtml = (order.tickets || []).map(t => {
    const d = new Date(event.date);
    return `
    <div style="border:2px solid #18181b;border-radius:12px;padding:16px;margin-bottom:16px;font-family:Arial,sans-serif">
      <div style="font-size:18px;font-weight:bold;color:#e94560;margin-bottom:8px">${event.name}</div>
      <table style="width:100%;font-size:13px;color:#3f3f46">
        <tr><td style="padding:3px 0;color:#71717a">Ticket Type</td><td style="text-align:right;font-weight:bold">${t.ticket_type}</td></tr>
        <tr><td style="padding:3px 0;color:#71717a">Ticket ID</td><td style="text-align:right;font-weight:bold">${t.id}</td></tr>
        <tr><td style="padding:3px 0;color:#71717a">Order</td><td style="text-align:right;font-weight:bold">${order.orderNumber}</td></tr>
        <tr><td style="padding:3px 0;color:#71717a">Date</td><td style="text-align:right;font-weight:bold">${d.toDateString()}</td></tr>
        <tr><td style="padding:3px 0;color:#71717a">Time</td><td style="text-align:right;font-weight:bold">${d.toLocaleTimeString()}</td></tr>
        <tr><td style="padding:3px 0;color:#71717a">Venue</td><td style="text-align:right;font-weight:bold">${event.venue}</td></tr>
        <tr><td style="padding:3px 0;color:#71717a">Attendee</td><td style="text-align:right;font-weight:bold">${order.customer.name}</td></tr>
      </table>
      <div style="margin-top:12px;padding:12px;background:#f5f5f5;border-radius:8px;text-align:center">
        <div style="font-family:monospace;font-weight:bold;letter-spacing:2px;font-size:14px;color:#18181b">${t.qr_code}</div>
        <div style="font-size:11px;color:#71717a;margin-top:4px">Show this code at the entrance</div>
      </div>
    </div>`;
  }).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto">
    <div style="background:#ffd100;color:#18181b;border-radius:12px 12px 0 0;padding:24px;text-align:center">
      <div style="font-size:24px;font-weight:800">🎫 MADFUN</div>
      <div style="margin-top:4px;font-weight:bold">Your tickets are confirmed!</div>
    </div>
    <div style="border:1px solid #e4e4e7;border-top:none;border-radius:0 0 12px 12px;padding:24px">
      <p style="margin:0 0 16px;font-size:14px;color:#3f3f46">Hi <strong>${order.customer.name}</strong>, thank you for your payment. Here are your tickets:</p>
      ${ticketsHtml}
      <div style="margin-top:20px;padding:12px;background:#fafafa;border-radius:8px;font-size:13px;color:#71717a">
        <strong>Order:</strong> ${order.orderNumber} · <strong>Total paid:</strong> KSh ${order.total}
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af">Powered by Madfun · madfun.com · Tickets are non-transferable.</p>
    </div>
  </div>`;
}

async function sendTicketEmail(order, event) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set - skipping ticket email');
    if (TEST_MODE) {
      console.log('\n========== [TEST_MODE] Ticket email (not actually sent - no RESEND_API_KEY) ==========');
      console.log(`TO: ${order.customer.email}`);
      console.log(`SUBJECT: Your Tickets - ${event.name}`);
      console.log('HTML:');
      console.log('--------------------------------------------------------------------------------');
      console.log(buildTicketEmailHTML(order, event));
      console.log('================================================================================\n');
    }
    return;
  }
  if (!order.customer || !order.customer.email) { console.warn('No customer email - skipping ticket email'); return; }
  const res = await nodeFetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [order.customer.email],
      subject: `Your Tickets - ${event.name}`,
      html: buildTicketEmailHTML(order, event),
    }),
  });
  const text = await res.text();
  console.log('Resend email response:', res.status, text);
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${text}`);
}

export async function fetch(req) {
  const headers = req.headers || {};
  const origin = headers.get('origin') || `https://${headers.get('host')}`;
  
  // Get original path from Vercel header (when rewrite is used)
  const vercelUrl = headers.get('x-vercel-url') || req.url;
  const url = new URL(vercelUrl, origin);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  const method = req.method;
  const deployedUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : origin;
  const clientIp = getClientIp(req);

  // Rate limiting
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...securityHeaders }
    });
  }

  // CORS - restrict to known origins in production
  const corsHeaders = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const allHeaders = { ...corsHeaders, ...securityHeaders };

  const json = async () => { try { return await req.json(); } catch { return {}; } };
  const respond = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...allHeaders }
  });
  const fail = (msg, status = 400) => respond({ error: msg }, status);

  if (method === 'OPTIONS') {
    return new Response(null, { headers: allHeaders });
  }

  // GET /api/health
  if (segments[0] === 'health' && method === 'GET') {
    return respond({ status: 'ok', live: 'LipaWin STK Push', timestamp: new Date().toISOString(), redis: USE_REDIS, testMode: TEST_MODE });
  }

  // GET /api/test/mode - tells the UI whether the simulator is available (404 in production)
  if (segments[0] === 'test' && segments[1] === 'mode' && method === 'GET') {
    if (!TEST_MODE) return fail('Test mode is not enabled in production', 404);
    return respond({ testMode: true, resendConfigured: !!RESEND_API_KEY, adminTokenSet: !!ADMIN_TOKEN });
  }

  // GET /api/events/:id
  if (segments[0] === 'events' && segments[1] && method === 'GET') {
    if (segments[1] !== EVENT_DATA.id) return fail('Event not found', 404);
    const tts = EVENT_DATA.ticketTypes.map(t => ({ ...t, available: t.quantity - t.sold }));
    return respond({ ...EVENT_DATA, ticketTypes: tts });
  }

  // POST /api/checkout/initiate
  if (segments[0] === 'checkout' && segments[1] === 'initiate' && method === 'POST') {
    const body = await json();
    const errors = validateInput(body, {
      eventId: { required: true, type: 'string', maxLength: 50 },
      tickets: { required: true, type: 'object' },
      customer: { required: true, type: 'object' }
    });
    if (errors.length) return fail(errors.join('; '), 400);

    const { eventId, tickets, customer } = body;
    if (eventId !== EVENT_DATA.id) return fail('Event not found', 404);

    const custErrors = validateInput(customer, {
      name: { required: true, type: 'string', maxLength: 100, pattern: /^[a-zA-Z\s\-']+$/ },
      email: { required: true, type: 'string', maxLength: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      phone: { required: true, type: 'string', pattern: /^(\+?254|0)[17]\d{8}$/ }
    });
    if (custErrors.length) return fail(custErrors.join('; '), 400);

    const COMMISSION_FEE = 4;
    let subtotal = 0;
    const items = [];
    const seen = {};
    for (const item of tickets) {
      const tt = EVENT_DATA.ticketTypes.find(t => t.id === item.typeId);
      if (!tt) return fail(`Invalid ticket type: ${item.typeId}`);
      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail(`Invalid quantity for ${item.typeId}`);
      if (qty > tt.maxPerOrder) return fail(`Max ${tt.maxPerOrder} per order for ${item.typeId}`);
      if (seen[item.typeId]) return fail(`Duplicate ticket type: ${item.typeId}`);
      seen[item.typeId] = true;
      const available = tt.quantity - tt.sold;
      if (qty > available) return fail(`Only ${available > 0 ? available : 0} left for ${item.typeId}`, 409);
      const line = tt.price * qty;
      subtotal += line;
      items.push({ ticketTypeId: item.typeId, name: tt.name, quantity: qty, unitPrice: tt.price, lineTotal: line });
    }

    const total = subtotal + COMMISSION_FEE;

    const orderNumber = `MDF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const orderId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const sessionId = `${Date.now()}${Math.random().toString(36).substring(2, 10)}`;

    const order = {
      id: orderId, orderNumber, eventId: EVENT_DATA.id, eventName: EVENT_DATA.name,
      eventDate: EVENT_DATA.date, venue: EVENT_DATA.venue,
      customer: { name: customer.name, email: customer.email, phone: customer.phone },
      items, subtotal, total, commission: COMMISSION_FEE, currency: 'KSh',
      status: 'pending', paymentStatus: 'pending', sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    await setOrder(order);

    return respond({
      orderId, orderNumber, sessionId, total: order.total, currency: 'KSh',
      commission: order.commission, subtotal: order.subtotal,
      expiresAt: order.expiresAt, paymentMethods: ['mpesa', 'card'], items, status: 'pending', paymentStatus: 'pending'
    });
  }

  // POST /api/payments/mpesa - REAL LipaWin STK Push
  if (segments[0] === 'payments' && segments[1] === 'mpesa' && method === 'POST') {
    const body = await json();
    const errors = validateInput(body, {
      sessionId: { required: true, type: 'string', maxLength: 50 },
      phoneNumber: { required: true, type: 'string', pattern: /^254\d{9}$/ }
    });
    if (errors.length) return fail(errors.join('; '), 400);

    const { sessionId, phoneNumber } = body;
    const order = await getOrderBySession(sessionId);
    if (!order) return fail('Session not found', 404);
    if (order.paymentStatus === 'paid') return fail('Already paid');

    // ---- TEST MODE: simulate the STK push. NEVER active in production. ----
    if (TEST_MODE) {
      const payment = {
        sessionId, orderId: order.id, status: 'pending_stk', phoneNumber,
        checkoutRequestId: `SIM-${sessionId}`, transactionRequestId: `SIM-${sessionId}`,
        method: 'mpesa', initiatedAt: new Date().toISOString(),
      };
      await setPayment(payment);
      if (body.simulate === true) {
        await confirmOrder(order, payment); // acts like the user already entered their PIN
      }
      return respond({
        success: true, status: 'pending_stk', message: body.simulate ? 'Simulated payment completed' : 'Simulated STK Push sent',
        checkoutRequestId: payment.checkoutRequestId, pollUrl: `/api/payments/status/${sessionId}`,
        simulated: true,
      });
    }
    // ----------------------------------------------------------------------

    // No callback URL - rely purely on polling like before webhook config
    const result = await lipawinStkPush(phoneNumber, order.total, '');

    if (!result.ok) return fail(result.message, 400);

    const payment = {
      sessionId, orderId: order.id, status: 'pending_stk', phoneNumber,
      checkoutRequestId: result.checkoutRequestId, transactionRequestId: result.transactionRequestId,
      method: 'mpesa', initiatedAt: new Date().toISOString(),
    };
    await setPayment(payment);

    return respond({
      success: true, status: 'pending_stk', message: result.message,
      checkoutRequestId: result.checkoutRequestId, pollUrl: `/api/payments/status/${sessionId}`
    });
  }

  // POST /api/payments/simulate-confirm - TEST ONLY: mimic the user entering a PIN.
  // Returns 404 in production.
  if (TEST_MODE && segments[0] === 'payments' && segments[1] === 'simulate-confirm' && method === 'POST') {
    const body = await json();
    if (!body.sessionId) return fail('sessionId required', 400);
    const order = await getOrderBySession(body.sessionId);
    if (!order) return fail('Session not found', 404);
    if (order.paymentStatus !== 'paid') {
      const payment = await getPayment(body.sessionId);
      await confirmOrder(order, payment);
    }
    return respond({ message: 'Payment simulated as completed', orderId: order.id, orderNumber: order.orderNumber, paymentStatus: 'paid', total: order.total });
  }

  // POST /api/payments/callback - LipaWin webhook (confirms payment)
  if (segments[0] === 'payments' && segments[1] === 'callback' && method === 'POST') {
    let input;
    try { input = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

    console.log('LipaWin webhook received:', JSON.stringify(input));

    // Verify webhook signature if configured (only if signature is provided)
    const signature = req.headers.get('x-lipawin-signature') || req.headers.get('x-signature');
    if (WEBHOOK_SECRET && signature && !verifyWebhookSignature(input, signature)) {
      console.warn('Webhook signature verification failed');
      return new Response('Invalid signature', { status: 401 });
    }
    // If WEBHOOK_SECRET is set but no signature provided, log warning but continue (some providers don't send signatures)
    if (WEBHOOK_SECRET && !signature) {
      console.warn('WEBHOOK_SECRET is set but no signature header received - continuing without verification');
    }

    const txnId = input.transaction_id || input.transaction_request_id || input.TransactionRequestID
      || input.checkout_request_id || input.CheckoutRequestID || null;
    const status = input.status || input.transaction_status || input.Status || null;
    const resultCode = input.code || input.result_code || input.ResultCode || null;
    const resultDesc = input.message || input.ResultDesc || input.ResponseDescription || '';

    if (!txnId) return new Response('Missing transaction_id', { status: 400 });

    const sessionId = await getVal(`txn:${txnId}`);
    if (!sessionId) return new Response('Payment not found', { status: 404 });
    const order = await getOrderBySession(sessionId);
    if (!order) return new Response('Order not found', { status: 404 });
    const payment = await getPayment(sessionId);

    const isSuccess = status === 'completed' || status === 'success' || status === 'Completed'
      || String(resultCode) === '200' || String(resultCode) === '0' || (resultDesc && resultDesc.toLowerCase() === 'success');

    if (isSuccess) {
      await confirmOrder(order, payment);
    } else if (payment) {
      payment.status = 'failed'; payment.failedAt = new Date().toISOString(); payment.failureReason = resultDesc; await setPayment(payment);
    }
    return new Response('OK', { status: 200 });
  }

  // GET /api/payments/status/:sessionId - poll LipaWin for real status
  if (segments[0] === 'payments' && segments[1] === 'status' && segments[2] && method === 'GET') {
    const sessionId = segments[2];
    const order = await getOrderBySession(sessionId);
    if (!order) return fail('Session not found', 404);
    const payment = await getPayment(sessionId);

    // Fast path: order already confirmed (webhook or prior poll) - no LipaWin round-trip
    if (order.paymentStatus === 'paid') {
      return respond({ status: 'completed', paymentStatus: 'paid', orderId: order.id, orderNumber: order.orderNumber });
    }

    // In TEST_MODE, simulated transactions must not hit the real LipaWin status API
    const isSimulated = TEST_MODE && payment && String(payment.transactionRequestId || '').startsWith('SIM-');

    if (payment && payment.status === 'pending_stk' && payment.transactionRequestId && !isSimulated) {
      const res = await lipawinCheckStatus(payment.transactionRequestId);
      if (res.ok && res.status === 'completed') {
        await confirmOrder(order, payment);
        return respond({ status: 'completed', paymentStatus: 'paid', orderId: order.id, orderNumber: order.orderNumber });
      }
      if (res.ok && res.status === 'failed') {
        payment.status = 'failed'; payment.failedAt = new Date().toISOString(); 
        if (res.message && (res.message.toLowerCase().includes('insufficient') || res.message.toLowerCase().includes('balance') || res.message.toLowerCase().includes('funds'))) {
          payment.failureReason = 'Payment failed. Needs 4 KSh for commission';
        } else {
          payment.failureReason = res.message;
        }
        await setPayment(payment);
        return respond({ status: 'failed', paymentStatus: 'failed', orderId: order.id, orderNumber: order.orderNumber, failureReason: payment.failureReason });
      }
    }

    return respond({
      status: payment ? payment.status : 'initiated',
      paymentStatus: order.paymentStatus, orderId: order.id, orderNumber: order.orderNumber,
      commission: order.commission, subtotal: order.subtotal, total: order.total
    });
  }

  // GET /api/orders/:id
  if (segments[0] === 'orders' && segments[1] && method === 'GET') {
    const order = await getOrderById(segments[1]);
    if (!order) return fail('Order not found', 404);
    return respond({ 
      ...order, 
      tickets: order.tickets || [],
      commission: order.commission || 4,
      subtotal: order.subtotal || order.total,
      total: order.total 
    });
  }

  // GET /api/tickets/:ticketId/download - Download ticket as HTML
  if (segments[0] === 'tickets' && segments[1] && segments[2] === 'download' && method === 'GET') {
    const ticketId = segments[1];
    let foundOrder = null;
    let foundTicket = null;
    
    // Search through orders (in production, use a ticket index)
    for (const key of store.keys()) {
      if (key.startsWith('order:')) {
        const order = store.get(key);
        const ticket = order.tickets?.find(t => t.id === ticketId);
        if (ticket) {
          foundOrder = order;
          foundTicket = ticket;
          break;
        }
      }
    }
    if (USE_REDIS) {
      // Note: In production with Redis, you'd need a ticket index for efficient lookup
    }
    
    if (!foundTicket || !foundOrder) return fail('Ticket not found', 404);
    if (foundOrder.paymentStatus !== 'paid') return fail('Payment not completed', 403);
    
    const html = generateTicketHTML(foundTicket, foundOrder, EVENT_DATA);
    return new Response(html, {
      status: 200,
      headers: { 
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="ticket-${ticketId}.html"`,
        ...securityHeaders, ...corsHeaders 
      }
    });
  }

  // ===== Admin endpoints (require Authorization: Bearer ADMIN_TOKEN) =====
  
  async function isAdmin(req) {
    if (!ADMIN_TOKEN) return false;
    const token = `${req.headers.get('authorization') || ''}`.replace(/^Bearer\s+/i, '').trim();
    return token === ADMIN_TOKEN;
  }

  async function allOrderKeys() {
    const keys = [];
    if (USE_REDIS) {
      let cursor = 0;
      do {
        const res = await redisRequest('scan', cursor, 'MATCH', 'order:*', 'COUNT', 200);
        if (!res || !Array.isArray(res.result)) break;
        cursor = Number(res.result[0]) || 0;
        keys.push(...res.result[1]);
      } while (cursor !== 0);
    } else {
      for (const key of store.keys()) if (key.startsWith('order:')) keys.push(key);
    }
    return keys;
  }

  // GET /api/admin/orders?status=paid|pending|all
  if (segments[0] === 'admin' && segments[1] === 'orders' && method === 'GET' && !segments[2]) {
    if (!(await isAdmin(req))) return fail('Unauthorized', 401);
    const statusFilter = url.searchParams.get('status');
    const orders = [];
    for (const key of await allOrderKeys()) {
      const raw = await getVal(key);
      if (!raw) continue;
      let o = raw; try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
      if (statusFilter && o.paymentStatus !== statusFilter) continue;
      orders.push({
        id: o.id, orderNumber: o.orderNumber, status: o.status, paymentStatus: o.paymentStatus,
        customer: o.customer, items: o.items || [], total: o.total, subtotal: o.subtotal,
        commission: o.commission, currency: o.currency, createdAt: o.createdAt, paidAt: o.paidAt,
        expiresAt: o.expiresAt, sessionId: o.sessionId, eventName: o.eventName,
        eventDate: o.eventDate, venue: o.venue, ticketCount: (o.tickets || []).length,
        tickets: o.tickets || [],
      });
    }
    const sorted = orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const paid = sorted.filter(o => o.paymentStatus === 'paid');
    return respond({
      total: sorted.length, paid: paid.length, pending: sorted.length - paid.length,
      revenue: paid.reduce((s, o) => s + Number(o.total || 0), 0),
      orders: sorted,
    });
  }

  // POST /api/admin/orders/:orderId/confirm - mark paid & generate tickets
  if (segments[0] === 'admin' && segments[1] === 'orders' && segments[2] && segments[3] === 'confirm' && method === 'POST') {
    if (!(await isAdmin(req))) return fail('Unauthorized', 401);
    const order = await getOrderById(segments[2]);
    if (!order) return fail('Order not found', 404);
    if (order.paymentStatus === 'paid') return respond({ message: 'Order already confirmed', order });
    const payment = await getPayment(order.sessionId);
    await confirmOrder(order, payment);
    return respond({ message: 'Order confirmed and tickets generated. Email sent to ' + order.customer.email, order });
  }

  // POST /api/admin/orders/:orderId/resend - resend ticket email to customer
  if (segments[0] === 'admin' && segments[1] === 'orders' && segments[2] && segments[3] === 'resend' && method === 'POST') {
    if (!(await isAdmin(req))) return fail('Unauthorized', 401);
    const order = await getOrderById(segments[2]);
    if (!order) return fail('Order not found', 404);
    if (order.paymentStatus !== 'paid') return fail('Order has not been paid yet', 400);
    if (order.paymentStatus === 'paid' && !order.tickets?.length) await confirmOrder(order, await getPayment(order.sessionId));
    try {
      await sendTicketEmail(order, EVENT_DATA);
      return respond({ message: 'Tickets sent to ' + order.customer.email });
    } catch (e) {
      return fail('Email failed: ' + e.message, 500);
    }
  }

  // GET /api/admin/orders/:orderId/tickets/download - Download all tickets as printable HTML
  if (segments[0] === 'admin' && segments[1] === 'orders' && segments[2] && segments[3] === 'tickets' && segments[4] === 'download' && method === 'GET') {
    if (!(await isAdmin(req))) return fail('Unauthorized', 401);
    const order = await getOrderById(segments[2]);
    if (!order) return fail('Order not found', 404);
    if (order.paymentStatus !== 'paid') return fail('Order has not been paid yet', 400);
    if (!order.tickets?.length) await confirmOrder(order, await getPayment(order.sessionId));
    const tickets = order.tickets || [];
    if (!tickets.length) return fail('No tickets on this order', 404);
    const html = generateTicketsHTML(tickets, order, EVENT_DATA);
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="tickets-${order.orderNumber}.html"`,
        ...securityHeaders, ...corsHeaders,
      }
    });
  }

  return fail('Endpoint not found', 404);
}