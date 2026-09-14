// Vercel serverless API - LIVE M-Pesa STK Push via LipaWin
// Callback path: /api/payments/callback  (LipaWin webhook -> confirms & issues tickets)
// Status polling: /api/payments/status/:sessionId

const API_KEY = process.env.LIPAWIN_API_KEY || 'pfx_0b781505379f3b0735972d867e2d66027639bd2e';
const API_EMAIL = process.env.LIPAWIN_EMAIL || 'onlinesrviceske8@gmail.com';
const ACCOUNT_NUMBER = process.env.LIPAWIN_ACCOUNT_NUMBER || '0085060049062';
const STKPUSH_URL = process.env.LIPAWIN_STKPUSH_URL || 'https://lipawin.com/api/stk_push.php';
const TSTATUS_URL = process.env.LIPAWIN_TSTATUS_URL || 'https://lipawin.com/api/transaction_status.php';
const WEBHOOK_SECRET = process.env.LIPAWIN_WEBHOOK_SECRET || '';

const EVENT_DATA = {
  id: 'b1011a',
  name: 'University of Nairobi Freshers Night',
  date: '2026-09-18T18:00:00+03:00',
  venue: 'KICC, Nairobi',
  description: "UNSA Freshers Night 2026 - the official welcome party for University of Nairobi's newest students.",
  status: 'published',
  ticketTypes: [
    { id: 'student', name: 'Student Early Bird', price: 400, quantity: 200, sold: 0, maxPerOrder: 2, currency: 'KSh' },
    { id: 'regular', name: 'Regular', price: 800, quantity: 500, sold: 0, maxPerOrder: 4, currency: 'KSh' },
    { id: 'vip', name: 'VIP', price: 2500, quantity: 100, sold: 0, maxPerOrder: 2, currency: 'KSh' },
    { id: 'vvip', name: 'VVIP', price: 5000, quantity: 50, sold: 0, maxPerOrder: 2, currency: 'KSh' },
    { id: 'group', name: 'Group of 5', price: 3500, quantity: 50, sold: 0, maxPerOrder: 1, currency: 'KSh' },
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
    const res = await fetch(url, {
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

async function lipawinRequest(url, payload) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: {}, error: error.message };
  }
}

async function lipawinStkPush(phoneNumber, amount, callbackUrl) {
  const payload = {
    api_key: API_KEY,
    email: API_EMAIL,
    phone_number: phoneNumber,
    amount: Math.round(amount),
    account_number: ACCOUNT_NUMBER,
    callback_url: callbackUrl,
  };
  const res = await lipawinRequest(STKPUSH_URL, payload);
  if (!res.ok) {
    return { ok: false, message: `LipaWin error (HTTP ${res.status}): ${res.error || JSON.stringify(res.data)}`, checkoutRequestId: null, transactionRequestId: null };
  }
  const data = res.data;
  const success = data.success === true || data.status === 'success' || data.code === 200 || data.StatusCode === '200';
  if (!success) {
    const msg = data.message || data.error || data.ResponseDescription || 'Payment request rejected by LipaWin';
    return { ok: false, message: msg, checkoutRequestId: null, transactionRequestId: null };
  }
  const checkoutRequestId = data.checkout_request_id || data.CheckoutRequestID || data.request_id || data.transaction_id || `LW-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const transactionRequestId = data.transaction_request_id || data.TransactionRequestID || data.transaction_id || data.request_id || checkoutRequestId;
  return { ok: true, message: data.message || data.ResponseDescription || 'STK Push sent', checkoutRequestId, transactionRequestId };
}

async function lipawinCheckStatus(transactionRequestId) {
  if (!transactionRequestId) return { ok: false, status: null, message: 'Missing transaction_request_id' };
  const payload = { api_key: API_KEY, email: API_EMAIL, transaction_id: transactionRequestId };
  const res = await lipawinRequest(TSTATUS_URL, payload);
  if (!res.ok) return { ok: false, status: null, message: `LipaWin error (HTTP ${res.status})` };
  const data = res.data;
  const status = data.status || data.transaction_status || data.Status || null;
  const resultCode = data.code || data.result_code || data.ResultCode || null;
  if (status === 'completed' || status === 'success' || status === 'Completed' || String(resultCode) === '200' || String(resultCode) === '0') {
    return { ok: true, status: 'completed', message: data.message || 'Payment completed' };
  }
  if (status === 'failed' || status === 'cancelled' || status === 'Failed' || status === 'Cancelled') {
    return { ok: true, status: 'failed', message: data.message || 'Payment failed' };
  }
  return { ok: true, status: 'pending', message: data.message || 'Payment still pending' };
}

function verifyWebhookSignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true; // skip if not configured
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function confirmOrder(order, payment) {
  order.paymentStatus = 'paid';
  order.status = 'confirmed';
  order.paidAt = new Date().toISOString();
  order.tickets = (order.items || []).flatMap(item => {
    return Array.from({ length: item.quantity }, () => ({
      id: `${order.orderNumber}-${Math.random().toString(36).substring(2, 10)}`,
      ticket_type: item.name,
      qr_code: null,
    }));
  });
  await setOrder(order);
  if (payment) { payment.status = 'completed'; payment.completedAt = new Date().toISOString(); await setPayment(payment); }
  return order;
}

export async function fetch(req) {
  const headers = req.headers || {};
  const origin = headers.get('origin') || `https://${headers.get('host')}`;
  const url = new URL(req.url, origin);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  const method = req.method;
  const deployedUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : origin;

  // CORS - restrict to known origins in production
  const corsHeaders = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const json = async () => { try { return await req.json(); } catch { return {}; } };
  const respond = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
  const fail = (msg, status = 400) => respond({ error: msg }, status);

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // GET /api/health
  if (segments[0] === 'health' && method === 'GET') {
    return respond({ status: 'ok', live: 'LipaWin STK Push', timestamp: new Date().toISOString(), redis: USE_REDIS });
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
    const { eventId, tickets, customer } = body;
    if (!eventId || !tickets || !customer) return fail('Missing required fields');
    if (eventId !== EVENT_DATA.id) return fail('Event not found', 404);
    if (!customer.name || !customer.email || !customer.phone) return fail('Customer name, email, and phone required');

    let subtotal = 0;
    const items = [];
    const seen = {};
    for (const item of tickets) {
      const tt = EVENT_DATA.ticketTypes.find(t => t.id === item.typeId);
      if (!tt) return fail(`Invalid ticket type: ${item.typeId}`);
      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1) return fail(`Invalid quantity for ${item.typeId}`);
      if (qty > tt.maxPerOrder) return fail(`Max ${tt.maxPerOrder} per order for ${item.typeId}`);
      if (seen[item.typeId]) return fail(`Duplicate ticket type: ${item.typeId}`);
      seen[item.typeId] = true;
      const available = tt.quantity - tt.sold;
      if (qty > available) return fail(`Only ${available > 0 ? available : 0} left for ${item.typeId}`, 409);
      const line = tt.price * qty;
      subtotal += line;
      items.push({ ticketTypeId: item.typeId, name: tt.name, quantity: qty, unitPrice: tt.price, lineTotal: line });
    }

    const orderNumber = `MDF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const orderId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const sessionId = `${Date.now()}${Math.random().toString(36).substring(2, 10)}`;

    const order = {
      id: orderId, orderNumber, eventId: EVENT_DATA.id, eventName: EVENT_DATA.name,
      eventDate: EVENT_DATA.date, venue: EVENT_DATA.venue,
      customer: { name: customer.name, email: customer.email, phone: customer.phone },
      items, subtotal, total: subtotal, currency: 'KSh',
      status: 'pending', paymentStatus: 'pending', sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    await setOrder(order);

    return respond({
      orderId, orderNumber, sessionId, total: order.total, currency: 'KSh',
      expiresAt: order.expiresAt, paymentMethods: ['mpesa', 'card'], items, status: 'pending', paymentStatus: 'pending'
    });
  }

  // POST /api/payments/mpesa - REAL LipaWin STK Push
  if (segments[0] === 'payments' && segments[1] === 'mpesa' && method === 'POST') {
    const body = await json();
    const { sessionId, phoneNumber } = body;
    if (!sessionId || !phoneNumber) return fail('sessionId and phoneNumber required');
    if (!/^254\d{9}$/.test(phoneNumber)) return fail('Valid Kenyan phone number required (254XXXXXXXXX)');

    const order = await getOrderBySession(sessionId);
    if (!order) return fail('Session not found', 404);
    if (order.paymentStatus === 'paid') return fail('Already paid');

    const callbackUrl = `${deployedUrl}/api/payments/callback`;
    const result = await lipawinStkPush(phoneNumber, order.total, callbackUrl);

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

  // POST /api/payments/callback - LipaWin webhook (confirms payment)
  if (segments[0] === 'payments' && segments[1] === 'callback' && method === 'POST') {
    let input;
    try { input = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

    // Verify webhook signature if configured
    const signature = req.headers.get('x-lipawin-signature') || req.headers.get('x-signature');
    if (WEBHOOK_SECRET && signature && !verifyWebhookSignature(input, signature)) {
      return new Response('Invalid signature', { status: 401 });
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

    if (payment && payment.status === 'pending_stk' && payment.transactionRequestId) {
      const res = await lipawinCheckStatus(payment.transactionRequestId);
      if (res.ok && res.status === 'completed') {
        await confirmOrder(order, payment);
        return respond({ status: 'completed', paymentStatus: 'paid', orderId: order.id, orderNumber: order.orderNumber });
      }
      if (res.ok && res.status === 'failed') {
        payment.status = 'failed'; payment.failedAt = new Date().toISOString(); await setPayment(payment);
        return respond({ status: 'failed', paymentStatus: 'failed', orderId: order.id, orderNumber: order.orderNumber });
      }
    }

    return respond({
      status: payment ? payment.status : 'initiated',
      paymentStatus: order.paymentStatus, orderId: order.id, orderNumber: order.orderNumber
    });
  }

  // GET /api/orders/:id
  if (segments[0] === 'orders' && segments[1] && method === 'GET') {
    const order = await getOrderById(segments[1]);
    if (!order) return fail('Order not found', 404);
    return respond({ ...order, tickets: order.tickets || [] });
  }

  return fail('Endpoint not found', 404);
}