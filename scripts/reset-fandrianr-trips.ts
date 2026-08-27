/**
 * Put fandrianr's two test trips back to the beginning: partly arrived, no
 * plan declared, nothing sent, nothing charged.
 *
 * Deliberately NOT "split already declared". Writing mode='split' straight
 * into the table skips the code that writes the fee, and produces a state the
 * app itself cannot reach: a card sitting in Kirim Duluan with Ship unlocked
 * because nothing was ever charged. Every test then starts from a lie.
 *
 * Kept as a file rather than typed out each time: a reset that misses a
 * shipment row leaves the orders saying nothing has gone while the shipments
 * say a box did, and the parcel pricing reads both — so it would charge for a
 * journey that never happened.
 *
 *   npx tsx --env-file-if-exists=.env.development.local scripts/reset-fandrianr-trips.ts
 */
import { getShipOrdersFiltered } from "../lib/db/fulfillment"
import sql from "../lib/db-pool"

const EVENTS = ["LSJP202602", "LSKR202602"]
const WHO = "fandrianr"

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
    console.error("Refusing to run: DATABASE_URL is not a local database.")
    process.exit(1)
  }

  const [c] = await sql<{ id: number }[]>`SELECT id FROM customers WHERE instagram_id = ${WHO}`
  if (!c) throw new Error(`${WHO} not found`)

  const ship = await sql`DELETE FROM shipments WHERE event = ANY(${EVENTS})
    AND lower(replace(customer,'@','')) = ${WHO} RETURNING id`
  const adj = await sql`DELETE FROM adjustments WHERE event = ANY(${EVENTS})
    AND lower(replace(customer,'@','')) = ${WHO}
    AND (auto OR description LIKE 'Ongkir kirim duluan%' OR description LIKE 'Gabung ongkir%'
         OR description LIKE 'Selisih ongkir JNE%') RETURNING id`
  await sql`UPDATE orders SET unit_ship = 0, unit_hold = 0, updated_at = NOW()
    WHERE event = ANY(${EVENTS}) AND lower(replace(customer,'@','')) = ${WHO}`
  await sql`UPDATE customer_shipping_prefs SET mode = 'wait', merge_key = NULL, set_by = 'customer', updated_at = NOW()
    WHERE customer_id = ${c.id} AND event = ANY(${EVENTS})`

  console.log(`removed ${ship.length} shipment row(s), ${adj.length} adjustment(s)`)

  const [{ shipped }] = (await sql`SELECT COALESCE(SUM(unit_ship),0)::int AS shipped FROM orders
    WHERE event = ANY(${EVENTS}) AND lower(replace(customer,'@','')) = ${WHO}`) as unknown as { shipped: number }[]
  const [{ n }] = (await sql`SELECT count(*)::int AS n FROM shipments
    WHERE event = ANY(${EVENTS}) AND lower(replace(customer,'@','')) = ${WHO}`) as unknown as { n: number }[]
  const [{ a }] = (await sql`SELECT count(*)::int AS a FROM adjustments
    WHERE event = ANY(${EVENTS}) AND lower(replace(customer,'@','')) = ${WHO}`) as unknown as { a: number }[]
  console.log(`units shipped ${shipped} · shipment rows ${n} · adjustments ${a}  ` +
    (shipped === 0 && n === 0 && a === 0 ? "✓ clean" : "✗ CHECK THIS"))
  console.log("both start undeclared — press Split Ship to run the real path")

  const r = await getShipOrdersFiltered({ segment: "all", search: WHO } as never) as {
    groups: { event: string; status: string; totalToShip: number; splitExtraOngkir: number }[]
  }
  console.table(r.groups.filter((g) => EVENTS.includes(g.event))
    .map((g) => ({ event: g.event, tab: g.status, toShip: g.totalToShip, wouldCost: g.splitExtraOngkir })))
  await sql.end()
}

main().catch(async (err) => { console.error(String(err).split("\n")[0]); await sql.end(); process.exit(1) })
