require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const crypto = require('crypto');
const cluster = require('cluster');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'dev-secret-change-in-production';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Project root (parent of mock-server) holds the cloned frontend
const PROJECT_ROOT = path.join(__dirname, '..');

// Simple in-memory session store
const adminSessions = new Map();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function adminAuth(req, res, next) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (!token) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.admin = session;
  next();
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: NODE_ENV === 'production' ? undefined : false,
  crossOriginEmbedderPolicy: false,
  hsts: NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false
}));

// Compression
app.use(compression());

// Trust proxy (for rate limiting behind nginx/load balancer)
app.set('trust proxy', 1);

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: NODE_ENV === 'production' ? 1000 : 10000, // requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});
app.use(globalLimiter);

// Stricter rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Stricter rate limiter for payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many payment requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

// CORS
app.use(cors({ 
  origin: NODE_ENV === 'production' ? false : true, // Configure for production
  credentials: true 
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Cookie parser middleware
app.use((req, res, next) => {
  const cookies = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(c => {
      const [key, val] = c.trim().split('=');
      cookies[key] = val;
    });
  }
  req.cookies = cookies;
  next();
});

// Validation error handler
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

// In-memory stores
const events = new Map();
const orders = new Map();
const payments = new Map();
const ticketInventory = new Map();

// Initialize event data
function initEventData() {
  const eventId = 'b1011a';
  events.set(eventId, {
    id: eventId,
    name: 'University of Nairobi Freshers Night',
    date: '2026-09-18T18:00:00+03:00',
    venue: 'KICC, Nairobi',
    description: 'UNSA Freshers Night 2026 — the official welcome party for University of Nairobi\'s newest students.',
    image: 'https://madfun.com/images/freshers-night.jpg',
    status: 'published',
    ticketTypes: [
      { id: 'student', name: 'STUDENTS', price: 400, currency: 'KSh', quantity: 500, sold: 127, maxPerOrder: 5 },
      { id: 'regular', name: 'REGULAR', price: 800, currency: 'KSh', quantity: 300, sold: 45, maxPerOrder: 5 },
      { id: 'vip', name: 'VIP', price: 2500, currency: 'KSh', quantity: 100, sold: 12, maxPerOrder: 2 },
      { id: 'group', name: 'GROUP OF 5', price: 3500, currency: 'KSh', quantity: 50, sold: 8, maxPerOrder: 1 }
    ]
  });

  // Initialize inventory
  events.get(eventId).ticketTypes.forEach(t => {
    ticketInventory.set(`${eventId}:${t.id}`, { available: t.quantity - t.sold, reserved: 0 });
  });
}
initEventData();

// Helper: Generate order number
function generateOrderNumber() {
  return `MDF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

// Helper: Generate QR code data URL
async function generateQRCode(data) {
  try {
    return await QRCode.toDataURL(JSON.stringify(data), { width: 256, margin: 2 });
  } catch {
    return null;
  }
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get event details
app.get('/api/events/:id', (req, res) => {
  const event = events.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// Validate ticket availability
app.post('/api/events/:id/tickets/validate', paymentLimiter, (req, res) => {
  const event = events.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { tickets } = req.body; // [{ typeId: 'student', quantity: 2 }]
  if (!tickets || !Array.isArray(tickets)) {
    return res.status(400).json({ error: 'Invalid tickets format' });
  }

  const results = tickets.map(item => {
    const ticketType = event.ticketTypes.find(t => t.id === item.typeId);
    if (!ticketType) return { typeId: item.typeId, valid: false, reason: 'Invalid ticket type' };

    const inventory = ticketInventory.get(`${req.params.id}:${item.typeId}`);
    const available = inventory?.available || 0;
    const requested = item.quantity || 1;

    return {
      typeId: item.typeId,
      name: ticketType.name,
      price: ticketType.price,
      currency: ticketType.currency,
      requested,
      available,
      valid: requested <= available && requested <= ticketType.maxPerOrder,
      reason: requested > available ? 'Not enough tickets available' :
              requested > ticketType.maxPerOrder ? `Max ${ticketType.maxPerOrder} per order` : null
    };
  });

  const allValid = results.every(r => r.valid);
  res.json({ valid: allValid, items: results });
});

// Reserve tickets (temporary hold)
app.post('/api/events/:id/tickets/reserve', paymentLimiter, (req, res) => {
  const event = events.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { tickets, sessionId } = req.body;
  if (!tickets || !sessionId) {
    return res.status(400).json({ error: 'Missing tickets or sessionId' });
  }

  // Check availability again
  for (const item of tickets) {
    const inventory = ticketInventory.get(`${req.params.id}:${item.typeId}`);
    if (!inventory || inventory.available < item.quantity) {
      return res.status(409).json({ error: 'Tickets no longer available' });
    }
  }

  // Reserve
  tickets.forEach(item => {
    const inv = ticketInventory.get(`${req.params.id}:${item.typeId}`);
    inv.available -= item.quantity;
    inv.reserved += item.quantity;
  });

  // Store reservation with 10 min expiry
  const reservation = { tickets, eventId: req.params.id, expiresAt: Date.now() + 10 * 60 * 1000 };
  orders.set(`reservation:${sessionId}`, reservation);

  res.json({ success: true, expiresIn: 600 });
});

// Initiate checkout
app.post('/api/checkout/initiate', paymentLimiter, [
  body('eventId').notEmpty().withMessage('Event ID required'),
  body('tickets').isArray({ min: 1 }).withMessage('At least one ticket required'),
  body('customer.email').isEmail().withMessage('Valid email required'),
  body('customer.phone').notEmpty().withMessage('Phone required'),
  body('customer.name').notEmpty().withMessage('Name required')
], validate, async (req, res) => {
  const { eventId, tickets, customer } = req.body;
  if (!eventId || !tickets || !customer) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const event = events.get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Validate customer data
  const { email, phone, name } = customer;
  if (!email || !phone || !name) {
    return res.status(400).json({ error: 'Customer email, phone, and name required' });
  }

  // Calculate totals
  let subtotal = 0;
  const orderItems = [];
  for (const item of tickets) {
    const ticketType = event.ticketTypes.find(t => t.id === item.typeId);
    if (!ticketType) return res.status(400).json({ error: `Invalid ticket type: ${item.typeId}` });
    const lineTotal = ticketType.price * item.quantity;
    subtotal += lineTotal;
    orderItems.push({
      ticketTypeId: item.typeId,
      name: ticketType.name,
      quantity: item.quantity,
      unitPrice: ticketType.price,
      lineTotal
    });
  }

  const serviceFee = Math.round(subtotal * 0.05); // 5% service fee
  const total = subtotal + serviceFee;

  const orderId = uuidv4();
  const orderNumber = generateOrderNumber();
  const sessionId = uuidv4();

  const order = {
    id: orderId,
    orderNumber,
    eventId,
    eventName: event.name,
    eventDate: event.date,
    venue: event.venue,
    customer: { email, phone, name },
    items: orderItems,
    subtotal,
    serviceFee,
    total,
    currency: 'KSh',
    status: 'pending',
    paymentStatus: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
    sessionId
  };

  orders.set(orderId, order);
  payments.set(sessionId, { orderId, status: 'initiated', method: null });

  res.json({
    orderId,
    orderNumber,
    sessionId,
    total,
    currency: 'KSh',
    expiresAt: order.expiresAt,
    paymentMethods: ['mpesa', 'card']
  });
});

// Get checkout session
app.get('/api/checkout/session/:sessionId', (req, res) => {
  const payment = payments.get(req.params.sessionId);
  if (!payment) return res.status(404).json({ error: 'Session not found' });

  const order = orders.get(payment.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  res.json({
    orderId: order.id,
    orderNumber: order.orderNumber,
    total: order.total,
    currency: order.currency,
    status: order.status,
    paymentStatus: order.paymentStatus,
    expiresAt: order.expiresAt,
    customer: order.customer,
    items: order.items
  });
});

// Process M-Pesa payment (mock)
app.post('/api/payments/mpesa', paymentLimiter, [
  body('sessionId').notEmpty().withMessage('Session ID required'),
  body('phoneNumber').matches(/^254\d{9}$/).withMessage('Valid Kenyan phone number required (254XXXXXXXXX)')
], validate, async (req, res) => {
  const { sessionId, phoneNumber } = req.body;
  if (!sessionId || !phoneNumber) {
    return res.status(400).json({ error: 'sessionId and phoneNumber required' });
  }

  const payment = payments.get(sessionId);
  if (!payment) return res.status(404).json({ error: 'Session not found' });

  const order = orders.get(payment.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.paymentStatus === 'paid') {
    return res.status(400).json({ error: 'Already paid' });
  }

  // Simulate STK Push
  const checkoutRequestId = `ws_CO_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  payment.status = 'pending_stk';
  payment.checkoutRequestId = checkoutRequestId;
  payment.phoneNumber = phoneNumber;
  payment.method = 'mpesa';
  payments.set(sessionId, payment);

  // Simulate async callback after 3 seconds
  setTimeout(() => {
    const updatedPayment = payments.get(sessionId);
    if (updatedPayment && updatedPayment.status === 'pending_stk') {
      // 90% success rate for demo
      const success = Math.random() > 0.1;
      handleMpesaCallback(checkoutRequestId, success);
    }
  }, 3000);

  res.json({
    success: true,
    checkoutRequestId,
    message: 'STK Push sent to your phone. Enter M-Pesa PIN to complete payment.',
    pollUrl: `/api/payments/status/${sessionId}`
  });
});

// Poll payment status
app.get('/api/payments/status/:sessionId', (req, res) => {
  const payment = payments.get(req.params.sessionId);
  if (!payment) return res.status(404).json({ error: 'Session not found' });

  const order = orders.get(payment.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  res.json({
    status: payment.status,
    paymentStatus: order.paymentStatus,
    orderId: order.id,
    orderNumber: order.orderNumber
  });
});

// Mock M-Pesa callback handler
function handleMpesaCallback(checkoutRequestId, success) {
  for (const [sessionId, payment] of payments.entries()) {
    if (payment.checkoutRequestId === checkoutRequestId) {
      const order = orders.get(payment.orderId);
      if (!order) return;

      if (success) {
        payment.status = 'completed';
        payment.completedAt = new Date().toISOString();
        order.paymentStatus = 'paid';
        order.status = 'confirmed';
        order.paidAt = new Date().toISOString();

        // Confirm ticket inventory (move reserved to sold)
        for (const item of order.items) {
          const inv = ticketInventory.get(`${order.eventId}:${item.ticketTypeId}`);
          if (inv) {
            inv.reserved -= item.quantity;
            const event = events.get(order.eventId);
            const tt = event?.ticketTypes.find(t => t.id === item.ticketTypeId);
            if (tt) tt.sold += item.quantity;
          }
        }

        // Generate tickets with QR codes
        order.tickets = [];
        for (const item of order.items) {
          for (let i = 0; i < item.quantity; i++) {
            const ticketId = uuidv4();
            const qrData = {
              ticketId,
              orderNumber: order.orderNumber,
              eventId: order.eventId,
              eventName: order.eventName,
              ticketType: item.name,
              date: order.eventDate,
              venue: order.venue
            };
            order.tickets.push({
              id: ticketId,
              ticketType: item.name,
              qrCode: null // Will be generated on demand
});
server.on('error', (err) => {
  console.error('Server error:', err);
});
          }
        }
      } else {
        payment.status = 'failed';
        payment.failedAt = new Date().toISOString();
        order.paymentStatus = 'failed';
        order.status = 'payment_failed';

        // Release reserved tickets
        for (const item of order.items) {
          const inv = ticketInventory.get(`${order.eventId}:${item.ticketTypeId}`);
          if (inv) {
            inv.available += item.quantity;
            inv.reserved -= item.quantity;
          }
        }
      }
      payments.set(sessionId, payment);
      orders.set(order.id, order);
      break;
    }
  }
}

// M-Pesa webhook (for real integration)
app.post('/api/webhooks/mpesa', express.raw({ type: 'application/json' }), (req, res) => {
  // In production, verify signature and parse callback
  console.log('M-Pesa webhook received:', req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Get order with tickets + QR codes
app.get('/api/orders/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Generate QR codes for tickets
  if (order.tickets && !order.tickets[0]?.qrCode) {
    for (const ticket of order.tickets) {
      const qrData = {
        ticketId: ticket.id,
        orderNumber: order.orderNumber,
        eventId: order.eventId,
        eventName: order.eventName,
        ticketType: ticket.ticketType,
        date: order.eventDate,
        venue: order.venue
      };
      ticket.qrCode = await generateQRCode(qrData);
    }
  }

  res.json(order);
});

// Get order by order number
app.get('/api/orders/number/:orderNumber', async (req, res) => {
  for (const order of orders.values()) {
    if (order.orderNumber === req.params.orderNumber) {
      if (order.tickets && !order.tickets[0]?.qrCode) {
        for (const ticket of order.tickets) {
          const qrData = {
            ticketId: ticket.id,
            orderNumber: order.orderNumber,
            eventId: order.eventId,
            eventName: order.eventName,
            ticketType: ticket.ticketType,
            date: order.eventDate,
            venue: order.venue
          };
          ticket.qrCode = await generateQRCode(qrData);
        }
      }
      return res.json(order);
    }
  }
  res.status(404).json({ error: 'Order not found' });
});

// Admin: Get all orders (for demo)
app.get('/api/admin/orders', (req, res) => {
  const allOrders = Array.from(orders.values()).filter(o => o.orderNumber);
  res.json(allOrders.map(o => ({
    orderNumber: o.orderNumber,
    eventName: o.eventName,
    customer: o.customer,
    total: o.total,
    status: o.status,
    paymentStatus: o.paymentStatus,
    createdAt: o.createdAt
  })));
});

// Admin: Get event stats
app.get('/api/admin/events/:id/stats', adminAuth, (req, res) => {
  const event = events.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const eventOrders = Array.from(orders.values()).filter(o => o.eventId === req.params.id && o.orderNumber);
  const paidOrders = eventOrders.filter(o => o.paymentStatus === 'paid');
  const totalRevenue = paidOrders.reduce((sum, o) => sum + o.total, 0);
  const totalTicketsSold = paidOrders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0), 0);

  res.json({
    eventId: event.id,
    eventName: event.name,
    totalOrders: eventOrders.length,
    paidOrders: paidOrders.length,
    pendingOrders: eventOrders.filter(o => o.paymentStatus === 'pending').length,
    failedOrders: eventOrders.filter(o => o.paymentStatus === 'failed').length,
    totalRevenue,
    totalTicketsSold,
    ticketTypes: event.ticketTypes.map(t => {
      const inv = ticketInventory.get(`${req.params.id}:${t.id}`);
      return {
        ...t,
        available: inv?.available || 0,
        reserved: inv?.reserved || 0
      };
    })
  });
});

// Admin: Get all orders with full details
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const { status, paymentStatus, page = 1, limit = 50 } = req.query;
  let allOrders = Array.from(orders.values()).filter(o => o.orderNumber);

  if (status) allOrders = allOrders.filter(o => o.status === status);
  if (paymentStatus) allOrders = allOrders.filter(o => o.paymentStatus === paymentStatus);

  allOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const start = (page - 1) * limit;
  const paginated = allOrders.slice(start, start + parseInt(limit));

  res.json({
    orders: paginated,
    total: allOrders.length,
    page: parseInt(page),
    totalPages: Math.ceil(allOrders.length / limit)
  });
});

// Admin: Get single order with tickets
app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.tickets && !order.tickets[0]?.qrCode) {
    for (const ticket of order.tickets) {
      const qrData = {
        ticketId: ticket.id,
        orderNumber: order.orderNumber,
        eventId: order.eventId,
        eventName: order.eventName,
        ticketType: ticket.ticketType,
        date: order.eventDate,
        venue: order.venue
      };
      ticket.qrCode = await generateQRCode(qrData);
    }
  }

  res.json(order);
});

// Admin: Get all payments
app.get('/api/admin/payments', adminAuth, (req, res) => {
  const { status, method, page = 1, limit = 50 } = req.query;
  let allPayments = Array.from(payments.entries()).map(([sessionId, p]) => ({
    sessionId,
    ...p,
    order: orders.get(p.orderId)
  })).filter(p => p.order);

  if (status) allPayments = allPayments.filter(p => p.status === status);
  if (method) allPayments = allPayments.filter(p => p.method === method);

  allPayments.sort((a, b) => new Date(b.order?.createdAt || 0) - new Date(a.order?.createdAt || 0));

  const start = (page - 1) * limit;
  const paginated = allPayments.slice(start, start + parseInt(limit));

  res.json({
    payments: paginated,
    total: allPayments.length,
    page: parseInt(page),
    totalPages: Math.ceil(allPayments.length / limit)
  });
});

// Admin: Refund payment
app.post('/api/admin/payments/:sessionId/refund', adminAuth, [
  body('reason').notEmpty().withMessage('Refund reason required')
], validate, (req, res) => {
  const payment = payments.get(req.params.sessionId);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  const order = orders.get(payment.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.paymentStatus !== 'paid') {
    return res.status(400).json({ error: 'Only paid orders can be refunded' });
  }

  const { reason } = req.body;

  payment.status = 'refunded';
  payment.refundedAt = new Date().toISOString();
  payment.refundReason = reason;
  payments.set(req.params.sessionId, payment);

  order.paymentStatus = 'refunded';
  order.status = 'refunded';
  order.refundedAt = new Date().toISOString();
  order.refundReason = reason;

  // Release tickets back to inventory
  for (const item of order.items) {
    const inv = ticketInventory.get(`${order.eventId}:${item.ticketTypeId}`);
    if (inv) {
      inv.reserved = Math.max(0, inv.reserved - item.quantity);
      const event = events.get(order.eventId);
      const tt = event?.ticketTypes.find(t => t.id === item.ticketTypeId);
      if (tt) tt.sold = Math.max(0, tt.sold - item.quantity);
      inv.available += item.quantity;
    }
  }

  orders.set(order.id, order);

  res.json({ success: true, message: 'Payment refunded successfully' });
});

// Admin: Mark payment as paid (manual)
app.post('/api/admin/payments/:sessionId/mark-paid', adminAuth, (req, res) => {
  const payment = payments.get(req.params.sessionId);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  const order = orders.get(payment.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.paymentStatus === 'paid') {
    return res.status(400).json({ error: 'Already paid' });
  }

  payment.status = 'completed';
  payment.completedAt = new Date().toISOString();
  payment.method = payment.method || 'manual';
  payments.set(req.params.sessionId, payment);

  order.paymentStatus = 'paid';
  order.status = 'confirmed';
  order.paidAt = new Date().toISOString();

  // Confirm ticket inventory
  for (const item of order.items) {
    const inv = ticketInventory.get(`${order.eventId}:${item.ticketTypeId}`);
    if (inv) {
      inv.reserved -= item.quantity;
      const event = events.get(order.eventId);
      const tt = event?.ticketTypes.find(t => t.id === item.ticketTypeId);
      if (tt) tt.sold += item.quantity;
    }
  }

  // Generate tickets
  order.tickets = [];
  for (const item of order.items) {
    for (let i = 0; i < item.quantity; i++) {
      const ticketId = uuidv4();
      order.tickets.push({
        id: ticketId,
        ticketType: item.name,
        qrCode: null
      });
    }
  }

  orders.set(order.id, order);

  res.json({ success: true, message: 'Payment marked as paid' });
});

// Admin login
app.post('/api/admin/login', authLimiter, [
  body('password').notEmpty().withMessage('Password required')
], validate, (req, res) => {
  const { password } = req.body;
  if (!password || hashPassword(password) !== hashPassword(ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = generateSessionToken();
  adminSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
  });

  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  });

  res.json({ success: true, message: 'Logged in successfully' });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) adminSessions.delete(token);
  res.clearCookie('admin_token');
  res.json({ success: true });
});

// Admin check auth
app.get('/api/admin/me', (req, res) => {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ authenticated: false });

  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ authenticated: false });
  }

  res.json({ authenticated: true });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Release expired reservations (cleanup job)
setInterval(() => {
  const now = Date.now();
  for (const [key, reservation] of orders.entries()) {
    if (key.startsWith('reservation:') && reservation.expiresAt < now) {
      for (const item of reservation.tickets) {
        const inv = ticketInventory.get(`${reservation.eventId}:${item.typeId}`);
        if (inv) {
          inv.available += item.quantity;
          inv.reserved -= item.quantity;
        }
      }
      orders.delete(key);
      console.log(`Released expired reservation: ${key}`);
    }
  }
}, 60000);

// Serve cloned frontend (static assets: css/js/html)
app.use(express.static(PROJECT_ROOT));

// Root -> event page
app.get('/', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'university-of-nairobi-freshers-night-b1011a.html'));
});
app.get('/events/university-of-nairobi-freshers-night-b1011a', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'university-of-nairobi-freshers-night-b1011a.html'));
});

console.log('About to start server on port', PORT);
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║   Madfun Mock Backend Running                ║
║   Port: ${PORT}                                  ║
║   Event: b1011a (UoN Freshers Night)         ║
║   Workers: ${cluster.isPrimary ? 'Primary (cluster mode)' : `Worker ${process.pid}`}              ║
╠═══════════════════════════════════════════════╣
║  Endpoints:                                  ║
║  GET  /api/health                            ║
║  GET  /api/events/:id                        ║
║  POST /api/events/:id/tickets/validate       ║
║  POST /api/events/:id/tickets/reserve        ║
║  POST /api/checkout/initiate                 ║
║  GET  /api/checkout/session/:sessionId       ║
║  POST /api/payments/mpesa                    ║
║  GET  /api/payments/status/:sessionId        ║
║  GET  /api/orders/:id                        ║
║  GET  /api/orders/number/:orderNumber        ║
║  GET  /api/admin/orders                      ║
║  GET  /api/admin/events/:id/stats            ║
╚═══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));