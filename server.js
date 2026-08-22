const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function seedDb() {
  return {
    event: {
      slug: "university-of-nairobi-freshers-night",
      category: "Festival",
      title: "University of Nairobi Freshers Night",
      date: "2026-09-19T18:00:00+03:00",
      venueName: "KICC",
      venueCity: "Nairobi",
      refundPolicy:
        "Full refund if the event is cancelled or rescheduled. Streaming tickets are non-refundable once the stream starts.",
      paymentMethods: ["Mobile Money", "Card"],
      about:
        "The University of Nairobi Students' Association welcomes the incoming class with an official Freshers Night celebration at the Kenyatta International Convention Centre. Expect an evening of music and entertainment, surprise guest performances, and thousands of students from every UoN campus under one roof. Doors open 6:00 PM and the programme runs late. Carry your student ID or admission letter for verification at the gate.",
      highlights: [
        "Live DJs and entertainment all night",
        "Meet students from across all UoN campuses",
        "Held at KICC — Nairobi's premier event venue",
        "Officially ticketed for a safe, organised experience",
      ],
    },
    tiers: [
      { id: "students", name: "STUDENTS", price: 400, total: 3000, sold: 1240 },
      { id: "non-students", name: "NON-STUDENT", price: 700, total: 2000, sold: 610 },
      { id: "vip", name: "VIP", price: 1000, total: 500, sold: 188 },
      { id: "vvip", name: "VVIP", price: 2000, total: 200, sold: 96 },
      { id: "group-of-5", name: "GROUP OF 5", price: 1500, total: 400, sold: 120 },
    ],
    orders: [],
  };
}

let db;

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } else {
    db = seedDb();
    saveDb();
  }
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function generateRef() {
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `UON-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function qrDataUrl(text) {
  const size = 21;
  const cells = [];
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  let s = seed;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const corner =
        (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
      if (corner) {
        const lx = x >= size - 7 ? x - (size - 7) : x;
        const ly = y >= size - 7 ? y - (size - 7) : y;
        const ring = Math.max(Math.abs(lx - 3), Math.abs(ly - 3));
        cells.push(ring !== 2 ? 1 : 0);
      } else {
        s = (s * 1103515245 + 12345) >>> 0;
        cells.push((s >> 16) & 1);
      }
    }
  }
  const px = 6;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size * px} ${size * px}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/>`;
  cells.forEach((c, i) => {
    if (!c) return;
    const x = (i % size) * px;
    const y = Math.floor(i / size) * px;
    svg += `<rect x="${x}" y="${y}" width="${px}" height="${px}" fill="#111111"/>`;
  });
  svg += "</svg>";
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function send(res, status, body, headers = {}) {
  const data =
    typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(data);
}

const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string") return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

const RATE_LIMITS = {
  api: Number(process.env.RATE_LIMIT_API) || 120,
  orders: Number(process.env.RATE_LIMIT_ORDERS) || 8,
};
const rateBuckets = new Map();

function rateLimit(req, key, max) {
  const ip = clientIp(req);
  const bucketKey = `${ip}:${key}`;
  const now = Date.now();
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 10_000) {
    for (const [k, b] of rateBuckets) {
      if (now > b.resetAt) rateBuckets.delete(k);
    }
  }
  return { allowed: bucket.count <= max, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

let orderChain = Promise.resolve();

let flushTimer = null;

function markDirty() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      saveDb();
    } catch (e) {
      console.error("Flush failed:", e.message);
    }
  }, 400);
}

function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  saveDb();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function publicEvent() {
  return {
    ...db.event,
    tiers: db.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      price: t.price,
      perks: t.perks,
      remaining: t.total - t.sold,
    })),
  };
}

function processOrder(body) {
  const { customer, items } = body;
  if (
    !customer ||
    typeof customer.name !== "string" ||
    !customer.name.trim() ||
    typeof customer.email !== "string" ||
    !/^\S+@\S+\.\S+$/.test(customer.email) ||
    typeof customer.phone !== "string" ||
    !/^[+\d][\d\s-]{7,}$/.test(customer.phone)
  ) {
    return { status: 400, error: true, message: "Valid name, email and phone are required." };
  }
  const paymentMethod = body.paymentMethod === "card" ? "Card" : "Mobile Money";
  if (!Array.isArray(items) || items.length === 0) {
    return { status: 400, error: true, message: "Select at least one ticket." };
  }

  const totals = new Map();
  for (const item of items) {
    const tier = db.tiers.find((t) => t.id === item.tierId);
    if (!tier) return { status: 400, error: true, message: `Unknown tier: ${item.tierId}` };
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      return { status: 400, error: true, message: `Quantity for ${tier.name} must be 1-10.` };
    }
    totals.set(tier.id, (totals.get(tier.id) || 0) + qty);
  }

  let totalAmount = 0;
  const lineItems = [];
  for (const [tierId, qty] of totals) {
    const tier = db.tiers.find((t) => t.id === tierId);
    const remaining = tier.total - tier.sold;
    if (qty > remaining) {
      return { status: 409, error: true, message: `Only ${remaining} "${tier.name}" ticket(s) left.` };
    }
    tier.sold += qty;
    totalAmount += tier.price * qty;
    lineItems.push({
      tierId,
      name: tier.name,
      qty,
      unitPrice: tier.price,
      subtotal: tier.price * qty,
    });
  }

  const ref = generateRef();
  const order = {
    ref,
    customer: {
      name: customer.name.trim(),
      email: customer.email.trim().toLowerCase(),
      phone: customer.phone.trim(),
    },
    items: lineItems,
    total: totalAmount,
    currency: "KES",
    paymentMethod,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  return { error: false, order: { ...order, qr: qrDataUrl(ref) } };
}

async function handleApi(req, res, pathname) {
  const limited = rateLimit(req, "api", RATE_LIMITS.api);
  if (!limited.allowed) {
    return send(res, 429, { error: "Too many requests. Slow down." }, {
      "Retry-After": String(limited.retryAfter),
    });
  }

  if (req.method === "GET" && pathname === "/api/event") {
    return send(res, 200, publicEvent());
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    const orderLimited = rateLimit(req, "orders", RATE_LIMITS.orders);
    if (!orderLimited.allowed) {
      return send(res, 429, { error: "Too many checkout attempts. Try again shortly." }, {
        "Retry-After": String(orderLimited.retryAfter),
      });
    }
    if (req.headers["content-type"] && !req.headers["content-type"].includes("application/json")) {
      return send(res, 415, { error: "Content-Type must be application/json" });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }

    const result = await orderChain.then(() => processOrder(body));
    if (result.error) {
      return send(res, result.status, { error: result.message });
    }
    markDirty();
    return send(res, 201, result.order);
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);
  if (req.method === "GET" && orderMatch) {
    const order = db.orders.find((o) => o.ref === orderMatch[1].toUpperCase());
    if (!order) return send(res, 404, { error: "Order not found." });
    return send(res, 200, { ...order, qr: qrDataUrl(order.ref) });
  }

  return send(res, 404, { error: "Not found" });
}

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, { error: "Forbidden" });
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  stream.pipe(res);
  stream.on("error", () => send(res, 500, { error: "Read error" }));
}

loadDb();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(req, res, pathname === "/" ? "/index.html" : pathname);
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Ticketing server running at http://localhost:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${sig} received — flushing data…`);
    try {
      flushNow();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
