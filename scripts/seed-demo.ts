/**
 * A dashboard with something in every screen.
 *
 * Local only, and idempotent: it clears what it made last time before making
 * it again, so re-running never doubles anything. Reference data it does not
 * own — events, countries, warehouses, settings — is left alone.
 *
 *   npx tsx --env-file-if-exists=.env.development.local scripts/seed-demo.ts
 *
 * The shape is a real trip cycle rather than random rows: one trip still being
 * shopped, one landed and being checked in, one already dispatched. That is
 * what makes Shopping List, Arrival List, Dispatch List, Packing List and
 * Shipments each have work waiting in them at the same time.
 */
import sql from "@/lib/db-pool"

const SHOPPING = "LSKR202603"   // being bought now
const ARRIVING = "POCN202603"   // landed, checking in
const SHIPPING = "LSDM202604"   // dispatched

const CUSTOMERS = [
  ["summerfey", "Fenny Sumarna", "628111000001", "Bandung", 25000],
  ["rinaaa", "Rina Wijaya", "628111000002", "Jakarta Selatan", 22000],
  ["dewi.p", "Dewi Puspita", "628111000003", "Surabaya", 30000],
  ["mamaqila", "Qila Hapsari", "628111000004", "Bandung", 25000],
  ["tiara.store", "Tiara Melati", "628111000005", "Bekasi", 24000],
  ["bundazaki", "Zaki Rahmawati", "628111000006", "Depok", 24000],
  ["nanaaa.id", "Nana Kurnia", "628111000007", "Tangerang", 24000],
  ["citra_mw", "Citra Maharani", "628111000008", "Semarang", 28000],
  ["linaaa.co", "Lina Kartika", "628111000009", "Yogyakarta", 28000],
  ["ayudiaaa", "Ayu Diah", "628111000010", "Malang", 30000],
  ["hanihani", "Hani Setiawan", "628111000011", "Medan", 38000],
  ["putri.olshop", "Putri Anggraini", "628111000012", "Makassar", 42000],
] as const

/** name, store, countryId, valas, gram, price */
const PRODUCTS = [
  ["Muji Boston Bag 38L Greige", "MUJI", 2, 3990, 620, 385000],
  ["Muji Boston Bag 38L Black", "MUJI", 2, 3990, 620, 385000],
  ["Muji Shoulder Bag 9L Beige", "MUJI", 2, 1990, 240, 210000],
  ["Muji Gel Ink Pen 0.5 Black 10pcs", "MUJI", 2, 890, 120, 105000],
  ["Muji Acrylic Drawer 3 Tier", "MUJI", 2, 2490, 900, 265000],
  ["Uniqlo Airism Tee Men L White", "UNIQLO", 2, 1500, 180, 170000],
  ["Uniqlo Ultra Light Down Vest Navy", "UNIQLO", 2, 3990, 320, 395000],
  ["Uniqlo Kids Legging 110 Grey", "UNIQLO", 2, 990, 110, 120000],
  ["Nishimatsuya Pyjama Beruang 100", "NISHIMATSUYA", 2, 1290, 210, 155000],
  ["Nishimatsuya Pyjama Beruang 110", "NISHIMATSUYA", 2, 1290, 215, 155000],
  ["Nishimatsuya Bib Set 3pcs", "NISHIMATSUYA", 2, 780, 90, 95000],
  ["Akachan Baby Lotion 300ml", "AKACHAN", 2, 980, 340, 118000],
  ["Akachan Diaper Tape M 68pcs", "AKACHAN", 2, 1580, 1400, 195000],
  ["Daiso Storage Box Clear L", "DAISO", 2, 330, 260, 42000],
  ["Daiso Kitchen Tongs Silicone", "DAISO", 2, 220, 80, 30000],
  ["Anello Backpack Regular Navy", "ANELLO", 2, 5900, 780, 560000],
  ["Skinfood Rice Mask Wash Off 100g", "SKINFOOD", 4, 12000, 180, 175000],
  ["Innisfree Green Tea Serum 80ml", "INNISFREE", 4, 26000, 220, 365000],
  ["Laneige Water Sleeping Mask 70ml", "LANEIGE", 4, 32000, 190, 445000],
  ["Olive Young Tone Up Cream 50ml", "OLIVE YOUNG", 4, 18000, 140, 255000],
  ["Kakao Friends Ryan Plush 25cm", "KAKAO", 4, 29000, 300, 405000],
  ["Stanley Quencher 1.2L Rose", "STANLEY", 1, 189, 780, 585000],
  ["Xiaomi Powerbank 20000mAh", "XIAOMI", 1, 119, 440, 375000],
  ["Miniso Sanrio Tumbler 500ml", "MINISO", 1, 59, 320, 195000],
  ["Charles & Keith Sling Bag Beige", "CHARLES & KEITH", 3, 149, 520, 685000],
] as const

const nowMinus = (days: number) => new Date(Date.now() - days * 86_400_000)

async function main() {
  const [db] = await sql`SELECT inet_server_addr()::text AS host`
  if (db.host && !/^(127\.|172\.|10\.|192\.168\.)/.test(db.host)) {
    throw new Error(`refusing to seed ${db.host} — this script is for local only`)
  }

  const handles = CUSTOMERS.map((c) => c[0])
  const events = [SHOPPING, ARRIVING, SHIPPING]

  // ── clear only what this script makes ────────────────────────────────────
  await sql`DELETE FROM payments WHERE customer = ANY(${handles})`
  await sql`DELETE FROM refunds WHERE customer = ANY(${handles})`
  await sql`DELETE FROM adjustments WHERE customer = ANY(${handles})`
  await sql`DELETE FROM shipments WHERE customer = ANY(${handles})`
  await sql`DELETE FROM orders WHERE customer = ANY(${handles})`
  await sql`DELETE FROM catalogue_requests WHERE customer_handle = ANY(${handles})`
  await sql`DELETE FROM excess_purchase WHERE event = ANY(${events})`
  await sql`DELETE FROM operational_expenses WHERE event = ANY(${events})`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (SELECT id FROM customers WHERE instagram_id = ANY(${handles}))`
  await sql`DELETE FROM customers WHERE instagram_id = ANY(${handles})`
  await sql`DELETE FROM products WHERE name = ANY(${PRODUCTS.map((p) => p[0])})`

  // ── customers, and their shipping rate at the default warehouse ──────────
  const [wh] = await sql`SELECT id FROM warehouses WHERE is_default ORDER BY id LIMIT 1`
  const customerIds = new Map<string, number>()
  for (const [handle, name, wa, kota, ongkir] of CUSTOMERS) {
    const [c] = await sql`
      INSERT INTO customers (instagram_id, name, whatsapp, kota, ongkos_kirim, ekspedisi, data_diri)
      VALUES (${handle}, ${name}, ${wa}, ${kota}, ${ongkir}, ${"JNE REG"},
              ${`${name}\n${wa}\nJl. Contoh No. 1, ${kota}`})
      RETURNING id`
    customerIds.set(handle, c.id as number)
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      VALUES (${c.id}, ${wh.id}, ${ongkir})
      ON CONFLICT (customer_id, warehouse_id) DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim`
  }

  // ── products ─────────────────────────────────────────────────────────────
  const productIds: number[] = []
  for (const [name, store, countryId, valas, gram, price] of PRODUCTS) {
    const [country] = await sql`SELECT kurs, cargo_per_kg FROM countries WHERE id = ${countryId}`
    const kurs = Number(country?.kurs ?? 1)
    const cost = Math.round(valas * kurs + (gram / 1000) * Number(country?.cargo_per_kg ?? 0))
    const [p] = await sql`
      INSERT INTO products (name, store, price, gram, country_id, valas, kurs,
                            cargo_per_kg, cost, profit_pct, is_active, pricing_method)
      VALUES (${name}, ${store}, ${price}, ${gram}, ${countryId}, ${valas}, ${kurs},
              ${country?.cargo_per_kg ?? 0}, ${cost}, ${20}, true, ${"overseas"})
      RETURNING id`
    productIds.push(p.id as number)
  }

  // ── orders, staged by trip ───────────────────────────────────────────────
  // A trip being shopped: most lines not bought yet, a few partly bought.
  // A trip that landed: everything bought, arrivals half checked in.
  // A trip dispatched: everything arrived, most shipped, one held back.
  let made = 0
  const place = async (
    event: string, handle: string, productId: number, unit: number,
    stage: "shopping" | "arriving" | "shipping", age: number,
  ) => {
    const [p] = await sql`SELECT price FROM products WHERE id = ${productId}`
    const buy = stage === "shopping" ? (made % 3 === 0 ? unit : 0) : unit
    const arrive = stage === "shopping" ? 0 : stage === "arriving" ? (made % 2 === 0 ? unit : 0) : unit
    const ship = stage === "shipping" ? (made % 5 === 0 ? 0 : unit) : 0
    await sql`
      INSERT INTO orders (event, customer, product_id, unit, unit_price, unit_buy,
                          unit_arrive, unit_ship, receipt, created_at)
      VALUES (${event}, ${handle}, ${productId}, ${unit}, ${p.price}, ${buy},
              ${arrive}, ${ship}, ${buy > 0 ? `RCP-${1000 + made}` : ""}, ${nowMinus(age)})`
    made++
  }

  const pick = (i: number) => productIds[i % productIds.length]
  for (let i = 0; i < 26; i++) {
    await place(SHOPPING, handles[i % handles.length], pick(i), (i % 3) + 1, "shopping", 3 + (i % 5))
  }
  for (let i = 0; i < 47; i++) {
    await place(ARRIVING, handles[(i + 3) % handles.length], pick(i + 7), (i % 2) + 1, "arriving", 12 + (i % 6))
  }
  for (let i = 0; i < 18; i++) {
    await place(SHIPPING, handles[(i + 5) % handles.length], pick(i + 13), 1, "shipping", 24 + (i % 8))
  }

  // ── money: payments (some unchecked, waiting to be reviewed), an
  //    adjustment either way, one overpayment sitting as a refund ──────────
  const invoiceOf = async (event: string, handle: string) => {
    const [r] = await sql`
      SELECT COALESCE(SUM(o.unit_price * o.unit), 0)::int AS subtotal
      FROM orders o WHERE o.event = ${event} AND o.customer = ${handle}`
    return Number(r.subtotal)
  }

  for (const event of events) {
    const inEvent = await sql`SELECT DISTINCT customer FROM orders WHERE event = ${event}`
    for (const [n, row] of inEvent.entries()) {
      const handle = row.customer as string
      const total = await invoiceOf(event, handle)
      if (total === 0) continue
      if (n % 4 === 0) continue                                   // owes everything
      const part = n % 3 === 0 ? Math.round(total * 0.5) : total  // half, or paid up
      await sql`
        INSERT INTO payments (event, customer, amount, account, is_checked, pay_date, remarks)
        VALUES (${event}, ${handle}, ${part}, ${n % 2 ? "BCA" : "JAGO"}, ${n % 5 !== 0},
                ${nowMinus(2 + n)}, ${n % 5 === 0 ? "Belum dicek" : "Transfer"})`
    }
  }

  await sql`INSERT INTO adjustments (event, customer, description, amount)
            VALUES (${SHOPPING}, ${"dewi.p"}, ${"Diskon langganan"}, ${-25000})`
  await sql`INSERT INTO adjustments (event, customer, description, amount)
            VALUES (${ARRIVING}, ${"hanihani"}, ${"Tambahan bubble wrap"}, ${15000})`

  // An overpayment that has not been sent back yet, so Refunds has a live row.
  const over = "tiara.store"
  const overTotal = await invoiceOf(SHIPPING, over)
  if (overTotal > 0) {
    await sql`INSERT INTO payments (event, customer, amount, account, is_checked, pay_date, remarks)
              VALUES (${SHIPPING}, ${over}, ${overTotal + 150000}, ${"BCA"}, true, ${nowMinus(6)}, ${"Transfer lebih"})`
    await sql`
      INSERT INTO refunds (event, customer, reason, refund_amount, status,
                           bank_name, bank_account_number, bank_account_holder, note)
      VALUES (${SHIPPING}, ${over}, ${"overpayment"}, ${150000}, ${"pending"},
              ${"BCA"}, ${"1234567890"}, ${"Tiara Melati"}, ${"Lebih transfer, tunggu konfirmasi rekening"})`
  }

  // ── parcels in transit, waiting at the warehouse door ────────────────────
  // The receiving list only shows a line once it has been dispatched and has
  // not fully arrived (unit_dispatch > 0 AND unit_arrive < unit_dispatch), so
  // the landed trip is staged as three parcels still to check in — one per
  // route, which is what the route tabs there are for.
  const inTransit = await sql`
    SELECT id FROM orders WHERE event = ${ARRIVING} AND unit_buy > 0 ORDER BY id`
  // Several boxes per route, at different ages, so each tab shows a list of
  // parcels rather than a single one — and so every colour appears somewhere.
  // Ages are days, read against the windows in lib/dispatch-modes:
  // hand carry 7/14, air 28/56, sea 56/84.
  const transitParcels = [
    ["HC-3101", 0, 5, 3],     // green — left this week
    ["HC-3115", 5, 8, 11],    // amber — a suitcase should have landed by now
    ["CJI-3104", 8, 14, 35],  // amber — past four weeks
    ["CJI-3120", 14, 19, 9],  // green — recent flight
    ["CJI-3098", 19, 24, 63], // red   — past eight weeks
    ["MNC-3109", 24, 29, 90], // red   — past twelve weeks
    ["MNC-3130", 29, 34, 24], // green — a month at sea is normal
    ["MNC-3061", 34, 38, 61], // amber — past eight weeks, not yet twelve
    // Parcels written the way packing actually writes them before the courier
    // number arrives. No prefix, so they file under Other with a grey clock —
    // nothing knows which route they took, and 30 days means one thing by sea
    // and another in a suitcase. These are the ones to practise renaming on.
    ["Box 2", 38, 41, 30],
    ["Bag 1", 41, 44, 6],
    ["Box 3", 44, 47, 70],
  ] as const
  for (const [receipt, from, to, ageDays] of transitParcels) {
    const ids = inTransit.slice(from, to).map((r) => r.id as number)
    if (!ids.length) continue
    await sql`
      UPDATE orders
      SET unit_dispatch = unit_buy, dispatch_receipt = ${receipt},
          -- part of each parcel already checked in, so the screen shows
          -- progress rather than an all-or-nothing wall
          unit_arrive = CASE WHEN id % 3 = 0 THEN unit_buy ELSE 0 END,
          dispatched_at = ${nowMinus(ageDays)},
          updated_at = ${nowMinus(2)}
      WHERE id = ANY(${ids})`
  }

  // One product deliberately split across two parcels: three of them flew, the
  // other two came by sea. It happens when a parcel fills up, and it is the
  // case the route tabs have to get right — the item belongs on both, not on
  // whichever route its first line happened to take.
  //
  // Built rather than found: every other product in this trip has a single
  // order, so nothing would otherwise span two parcels and the behaviour would
  // go untested by the fixture.
  const splitProduct = productIds[8]
  const [splitPriced] = await sql`SELECT price FROM products WHERE id = ${splitProduct}`
  const splitRows: number[] = []
  for (const [n, handle] of ["mamaqila", "bundazaki", "linaaa.co", "ayudiaaa", "hanihani"].entries()) {
    const [o] = await sql`
      INSERT INTO orders (event, customer, product_id, unit, unit_price, unit_buy,
                          unit_dispatch, unit_arrive, receipt, created_at)
      VALUES (${ARRIVING}, ${handle}, ${splitProduct}, 1, ${splitPriced.price}, 1,
              1, 0, ${`RCP-31${n}`}, ${nowMinus(9)})
      RETURNING id`
    splitRows.push(o.id as number)
  }
  // Same dates as the parcels they join: a receipt is one box that left once,
  // so two dates under one code would be a bug the screen would faithfully show.
  await sql`UPDATE orders SET dispatch_receipt = ${"CJI-3104"}, dispatched_at = ${nowMinus(35)}
            WHERE id = ANY(${splitRows.slice(0, 3)})`
  await sql`UPDATE orders SET dispatch_receipt = ${"MNC-3109"}, dispatched_at = ${nowMinus(90)}
            WHERE id = ANY(${splitRows.slice(3)})`

  // ── dispatched lines, on all three routes ────────────────────────────────
  // The receipt prefix is how the dispatch screen tells routes apart: HC in a
  // suitcase, CJI by air, MNC by sea. One receipt covers several lines, which
  // is what a real parcel looks like.
  const toDispatch = await sql`
    SELECT id, customer FROM orders WHERE event = ${SHIPPING} AND unit_ship > 0 ORDER BY id`
  const parcels = [
    ["HC-2601", 0, 4], ["HC-2604", 4, 6], ["CJI-2607", 6, 10],
    ["CJI-2612", 10, 12], ["MNC-2618", 12, 15],
  ] as const
  for (const [receipt, from, to] of parcels) {
    const ids = toDispatch.slice(from, to).map((r) => r.id as number)
    if (!ids.length) continue
    await sql`
      UPDATE orders SET unit_dispatch = unit_buy, dispatch_receipt = ${receipt},
                        updated_at = ${nowMinus(4 + parcels.findIndex((p) => p[0] === receipt))}
      WHERE id = ANY(${ids})`
  }
  // One typo, so the "Other" bucket earns its place on screen.
  const [stray] = toDispatch.slice(15, 16)
  if (stray) {
    await sql`UPDATE orders SET unit_dispatch = unit_buy, dispatch_receipt = ${"XJ-9001"},
                                updated_at = ${nowMinus(3)} WHERE id = ${stray.id}`
  }

  // ── shipments for the dispatched trip ────────────────────────────────────
  const shipped = await sql`SELECT DISTINCT customer FROM orders WHERE event = ${SHIPPING} AND unit_ship > 0 LIMIT 6`
  for (const [n, row] of shipped.entries()) {
    await sql`
      INSERT INTO shipments (event, customer, shipping_id, tracking_number, ongkir,
                             weight_estimation, is_last_shipment, created_at)
      VALUES (${SHIPPING}, ${row.customer}, ${`SHIP-${2600 + n}`},
              ${n < 4 ? `JP${9000000000 + n}` : ""}, ${24000}, ${1.4 + n * 0.3},
              ${n % 3 === 0}, ${nowMinus(5 + n)})`
  }

  // ── ready stock from overbuys, and the trip's own costs ──────────────────
  await sql`INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive, reason, receipt)
            VALUES (${ARRIVING}, ${"Muji Gel Ink Pen 0.5 Black 10pcs"}, 3, 3, ${"overbuy"}, ${"RCP-2201"}),
                   (${ARRIVING}, ${"Daiso Storage Box Clear L"}, 2, 2, ${"overship"}, ${"RCP-2202"}),
                   (${SHIPPING}, ${"Nishimatsuya Bib Set 3pcs"}, 1, 1, ${"bad item"}, ${"RCP-2203"})`

  await sql`
    INSERT INTO operational_expenses (event, expense_date, description, category,
                                      amount_foreign, rate, amount_idr, is_settled, method)
    VALUES (${SHOPPING}, ${nowMinus(4)}, ${"Taksi ke Myeongdong"}, ${"transport"}, 24000, 14, 336000, true, ${"cash"}),
           (${SHOPPING}, ${nowMinus(3)}, ${"Koper tambahan"}, ${"packing"}, 0, 0, 450000, false, ${"transfer"}),
           (${ARRIVING}, ${nowMinus(11)}, ${"Bea masuk"}, ${"customs"}, 0, 0, 1250000, true, ${"transfer"}),
           (${SHIPPING}, ${nowMinus(20)}, ${"Kardus & bubble wrap"}, ${"packing"}, 0, 0, 185000, true, ${"cash"})`

  // ── one catalogue post with two requests against it ──────────────────────
  const [post] = await sql`
    INSERT INTO catalogue_posts (media_url, media_type, title, visible)
    VALUES (${"https://placehold.co/900x1200/EEE6DA/7B1A1A?text=MUJI+restock"}, ${"photo"},
            ${"MUJI restock"}, true)
    RETURNING id`
  await sql`INSERT INTO catalogue_post_products (post_id, product_id) VALUES (${post.id}, ${productIds[0]}), (${post.id}, ${productIds[1]})`
  await sql`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note, status, post_id, source)
    VALUES (${"nanaaa.id"}, ${productIds[0]}, 1, ${"Yang greige ya kak"}, ${"pending"}, ${post.id}, ${"catalogue"}),
           (${"citra_mw"}, ${productIds[1]}, 2, ${"Hitam dua"}, ${"pending"}, ${post.id}, ${"catalogue"})`

  const [count] = await sql`
    SELECT (SELECT count(*)::int FROM customers) AS customers,
           (SELECT count(*)::int FROM products) AS products,
           (SELECT count(*)::int FROM orders) AS orders,
           (SELECT count(*)::int FROM payments) AS payments,
           (SELECT count(*)::int FROM shipments) AS shipments,
           (SELECT count(*)::int FROM refunds) AS refunds,
           (SELECT count(*)::int FROM excess_purchase) AS inventory,
           (SELECT count(*)::int FROM operational_expenses) AS expenses,
           (SELECT count(*)::int FROM catalogue_requests) AS requests`
  console.log("seeded:")
  for (const [k, v] of Object.entries(count)) console.log(`  ${k.padEnd(12)} ${v}`)
  await sql.end()
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1) })
