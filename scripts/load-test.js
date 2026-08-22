const BASE = process.argv[2] || "http://localhost:3000";

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const ev = await api("/api/event");
  if (ev.status !== 200) throw new Error("event fetch failed");
  const tier = ev.body.tiers.find((t) => t.remaining > 60);
  if (!tier) throw new Error("no tier with enough stock for the test");

  const before = tier.remaining;
  const attempts = before + 30;
  console.log(`Tier "${tier.name}": ${before} left. Firing ${attempts} concurrent qty-1 orders…`);

  const payload = JSON.stringify({
    customer: { name: "Load Test", email: "load@test.dev", phone: "+254700000000" },
    items: [{ tierId: tier.id, qty: 1 }],
  });

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      api("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      })
    )
  );
  const ms = Date.now() - started;

  const ok = results.filter((r) => r.status === 201);
  const soldOut = results.filter((r) => r.status === 409);
  const limited = results.filter((r) => r.status === 429);
  const other = results.filter((r) => ![201, 409, 429].includes(r.status));

  const after = (await api("/api/event")).body.tiers.find((t) => t.id === tier.id).remaining;
  const refs = new Set(ok.map((r) => r.body.ref));

  console.log(`Completed in ${ms}ms (~${Math.round((attempts / ms) * 1000)} req/s)`);
  console.log(`201 confirmed : ${ok.length}`);
  console.log(`409 sold-out  : ${soldOut.length}`);
  console.log(`429 rate-limit: ${limited.length}`);
  if (other.length) console.log(`unexpected    : ${other.length} -> ${other[0].status}`, other[0].body);
  console.log(`stock before  : ${before}`);
  console.log(`stock after   : ${after}`);
  console.log(`unique refs   : ${refs.size}`);

  const pass =
    ok.length === before - after &&
    after >= 0 &&
    refs.size === ok.length &&
    (!limited.length || ok.length + limited.length === attempts);
  console.log(pass ? "\nPASS — no oversell, no duplicate refs." : "\nFAIL — inventory invariant broken!");
}

main().catch((e) => {
  console.error("Test error:", e.message);
  process.exit(1);
});
