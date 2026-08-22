const state = { event: null, cart: {} };

const $ = (sel) => document.querySelector(sel);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function fmt(n) {
  return `KSh ${n.toLocaleString("en-KE")}`;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

function renderEvent(ev) {
  state.event = ev;

  $("#ev-category").textContent = ev.category;
  $("#ev-title").textContent = ev.title;
  $("#ev-venue").textContent = ev.venueName;
  $("#ev-city").textContent = ev.venueCity;
  $("#ev-venue-name").textContent = ev.venueName;
  $("#ev-venue-city").textContent = ev.venueCity;
  $("#ev-about").textContent = ev.about;
  $("#ev-refunds").textContent = ev.refundPolicy;

  const d = new Date(ev.date);
  $("#ev-date").textContent =
    d.toLocaleDateString("en-KE", {
      weekday: "short",
      day: "numeric",
      month: "short",
    }) +
    ", " +
    d.toLocaleTimeString("en-KE", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();

  $("#ev-highlights").innerHTML = ev.highlights.map((h) => `<li>${esc(h)}</li>`).join("");

  const cheapest = Math.min(...ev.tiers.filter((t) => t.remaining > 0).map((t) => t.price));
  $("#from-price").textContent = `KSh ${cheapest.toLocaleString("en-KE")}`;

  $("#tier-rows").innerHTML = ev.tiers
    .map(
      (t) => `
      <div class="tier-row ${t.remaining === 0 ? "soldout" : ""}" data-id="${esc(t.id)}">
        <span class="t-name">${esc(t.name)}</span>
        <span class="t-price">KSh ${t.price.toLocaleString("en-KE")}</span>
        <div class="stepper">
          <button type="button" data-action="dec" aria-label="decrease" ${
            t.remaining === 0 ? "disabled" : ""
          }>−</button>
          <span class="qty" id="qty-${t.id}">${state.cart[t.id] || 0}</span>
          <button type="button" data-action="inc" aria-label="increase" ${
            t.remaining === 0 ? "disabled" : ""
          }>+</button>
        </div>
      </div>`
    )
    .join("");

  renderTotal();
}

function renderTotal() {
  let total = 0;
  if (state.event) {
    for (const [id, qty] of Object.entries(state.cart)) {
      const tier = state.event.tiers.find((t) => t.id === id);
      if (tier && qty > 0) total += tier.price * qty;
    }
  }
  $("#cart-total").textContent = fmt(total);
}

function cartCount() {
  return Object.values(state.cart).reduce((a, b) => a + b, 0);
}

function setQty(id, delta) {
  const tier = state.event.tiers.find((t) => t.id === id);
  const max = Math.min(10, tier.remaining);
  state.cart[id] = Math.min(Math.max(0, (state.cart[id] || 0) + delta), max);
  $(`#qty-${id}`).textContent = state.cart[id];
  renderTotal();
}

async function refreshEvent() {
  const ev = await api("/api/event");
  renderEvent(ev);
}

function openCheckout() {
  $("#checkout-error").hidden = true;
  $("#checkout-modal").showModal();
}

async function submitCheckout(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const payBtn = $("#checkout-pay");
  payBtn.disabled = true;
  payBtn.textContent = "Processing…";
  try {
    const order = await api("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: {
          name: form.get("name"),
          email: form.get("email"),
          phone: form.get("phone"),
        },
        paymentMethod: form.get("paymentMethod"),
        items: Object.entries(state.cart)
          .filter(([, q]) => q > 0)
          .map(([tierId, qty]) => ({ tierId, qty })),
      }),
    });
    $("#checkout-modal").close();
    showTicket(order);
    state.cart = {};
    refreshEvent();
  } catch (err) {
    const el = $("#checkout-error");
    el.textContent = err.message;
    el.hidden = false;
  } finally {
    payBtn.disabled = false;
    payBtn.textContent = "Pay now";
  }
}

function showTicket(order) {
  $("#ticket-qr").src = order.qr;
  $("#ticket-ref").textContent = order.ref;
  $("#ticket-summary").innerHTML =
    order.items
      .map((i) => `<p>${esc(i.name)} × ${i.qty}<strong>${fmt(i.subtotal)}</strong></p>`)
      .join("") +
    `<hr style="border:none;border-top:1px dashed var(--border);margin:8px 0" />
     <p>Paid via ${esc(order.paymentMethod)}<strong>${fmt(order.total)}</strong></p>`;
  $("#ticket-modal").showModal();
}

async function lookupOrder(e) {
  e.preventDefault();
  try {
    const order = await api(`/api/orders/${encodeURIComponent($("#lookup-ref").value.trim())}`);
    showTicket(order);
  } catch {
    $("#lookup-result").innerHTML = `<p class="error">Order not found — check the reference and try again.</p>`;
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (btn) setQty(btn.closest(".tier-row").dataset.id, btn.dataset.action === "inc" ? 1 : -1);
});

$("#checkout-btn").addEventListener("click", () => {
  if (cartCount() > 0) openCheckout();
});
$("#checkout-cancel").addEventListener("click", () => $("#checkout-modal").close());
$("#checkout-form").addEventListener("submit", submitCheckout);
$("#ticket-close").addEventListener("click", () => $("#ticket-modal").close());
$("#find-order-btn2").addEventListener("click", (e) => {
  e.preventDefault();
  openLookup();
});
$("#find-order-btn").addEventListener("click", openLookup);

function openLookup() {
  if (!document.getElementById("lookup")) {
    document.querySelector(".page").insertAdjacentHTML(
      "beforeend",
      `<section id="lookup" class="lookup">
         <h2>Find your ticket</h2>
         <form id="lookup-form" class="lookup-form">
           <input type="text" id="lookup-ref" placeholder="UON-XXXX-XXXX" autocomplete="off" required />
           <button class="btn primary" type="submit">Search</button>
         </form>
         <div id="lookup-result"></div>
       </section>`
    );
    $("#lookup-form").addEventListener("submit", lookupOrder);
  }
  document.getElementById("lookup").scrollIntoView({ behavior: "smooth" });
}

refreshEvent().catch(() => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<p style="text-align:center;padding:12px;background:#ffe4e4;color:#900">Could not reach the ticket server. Run: node server.js</p>'
  );
});
