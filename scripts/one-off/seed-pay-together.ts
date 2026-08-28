/**
 * Seed the dev database with the two things that need clicking:
 *
 *   1. Pay-together -- one customer owed three separate things on one trip, so
 *      the Execute transfer card has siblings to list.
 *   2. The double-count that made pay-together dangerous -- an overpayment
 *      filed BEFORE a mark, on a second customer, so the arithmetic can be read
 *      off the screen rather than taken on trust.
 *
 * Safe to run more than once: it deletes its own rows first, and it only ever
 * touches handles beginning with `zztest_`.
 *
 *   npx tsx --env-file=.env.development.local scripts/one-off/seed-pay-together.ts
 *   npx tsx --env-file=.env.development.local scripts/one-off/seed-pay-together.ts --clean
 */
import sql from "../../lib/db-pool"

const PREFIX = "zztest_"
const TOGETHER = `${PREFIX}bertiga`
const DRIFT = `${PREFIX}lebihbayar`

async function clean() {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${PREFIX}%`})`
  await sql`DELETE FROM payments WHERE customer LIKE ${`${PREFIX}%`}`
  await sql`DELETE FROM refunds WHERE customer LIKE ${`${PREFIX}%`}`
  await sql`DELETE FROM orders WHERE customer LIKE ${`${PREFIX}%`}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${PREFIX}%`})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${PREFIX}%`}`
}

async function main() {
  if (process.argv.includes("--clean")) {
    await clean()
    console.log("Removed every zztest_ row.")
    return
  }

  await clean()

  // A live, active trip so the rows show up where you would look for them.
  const [event] = await sql<{ name: string; warehouse_id: number }[]>`
    SELECT name, warehouse_id FROM events WHERE is_active = true
     ORDER BY created_at DESC LIMIT 1`
  if (!event) throw new Error("No active event on this database to hang the seed off")

  // Weightless, so the invoice is exactly unit_price x unit and every figure
  // below can be checked by hand without the ongkir rounding joining in.
  const [prod] = await sql<{ id: number; name: string }[]>`
    SELECT id, name FROM products WHERE COALESCE(gram, 0) = 0 AND name <> '' ORDER BY id LIMIT 1`
  if (!prod) throw new Error("No zero-gram product to order")

  for (const who of [TOGETHER, DRIFT]) {
    await sql`INSERT INTO customers (instagram_id, whatsapp) VALUES (${who}, '628123456789')`
  }

  // ── 1. Three refunds, one trip, one customer ───────────────────────────────
  //
  // She ordered 5, paid for all 5, and three of them fell over in three
  // different ways. Each has its own reason, so each is its own row.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${event.name}, ${TOGETHER}, ${prod.id}, 100000, 5, 5)`
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind, remarks)
    VALUES (${event.name}, ${TOGETHER}, 500000, 'BCA', true, 'deposit', 'seed: paid in full')`

  // Marks write the item and the count into the note as they go, one line per
  // item where several merged into the same refund. That is what a group opens
  // to show, so the seed has to carry it.
  const three: [string, number, string, string][] = [
    // All three at the same step, so they collapse into one row on the Pending
    // tab -- which is the thing to look at. lebihbayar below covers the other
    // shape, where what is owed is spread across steps.
    ["unavailable", 160000, "pending", "Muji Bucket Hat with String × 1\nMuji Aroma Diffuser Small × 1"],
    ["shipping_loss", 200000, "pending", "Muji Boston Bag 38L Greige × 2"],
    ["damaged", 100000, "pending", "Muji Shoulder Bag 9L Beige × 1"],
  ]
  for (const [reason, amount, status, items] of three) {
    await sql`
      INSERT INTO refunds (event, customer, reason, refund_amount, status,
                           bank_name, bank_account_number, bank_account_holder, note)
      VALUES (${event.name}, ${TOGETHER}, ${reason}, ${amount}, ${status},
              '', '', '', ${items})`
  }

  // ── 2. The overpayment that used to double-count ───────────────────────────
  //
  // She ordered 2 at 200.000 and transferred 500.000 -- 100.000 too much. Then
  // one of the two turned out to be unavailable, so her invoice fell to 200.000
  // and a goods refund of 200.000 was raised.
  //
  // Her balance is now 300.000. Before the fix the overpayment row read all
  // 300.000 and the two together promised 500.000 against a 300.000 surplus.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${event.name}, ${DRIFT}, ${prod.id}, 200000, 1, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind, remarks)
    VALUES (${event.name}, ${DRIFT}, 500000, 'BCA', true, 'deposit', 'seed: transferred 100.000 too much')`
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status, note)
    VALUES (${event.name}, ${DRIFT}, 'overpayment', 100000, 'pending',
            'seed: filed BEFORE the mark, from a transfer typed wrong')`
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status,
                         bank_name, bank_account_number, bank_account_holder, note)
    VALUES (${event.name}, ${DRIFT}, 'unavailable', 200000, 'ready_to_refund',
            'BCA', '9876543210', 'Seed Lebih Bayar', 'seed: the unit she is not getting')`

  console.log(`Seeded on ${event.name}, item "${prod.name}".

  ${TOGETHER}
    invoice 500.000, paid 500.000
    3 refunds, all Pending, no bank details on any of them
    → Refunds → Pending. She is ONE row: "3 refunds", Rp 460.000, with a caret.
      Open it to see the three reasons. "Pay all (3)" asks for her account
      (empty here -- it refuses to send until you type one).

  ${DRIFT}
    invoice 200.000, paid 500.000, balance 300.000
    overpayment 100.000 (Pending) + unavailable 200.000 (Transfer)
    → the overpayment should read Rp 100.000, not Rp 300.000.
      The two together come to exactly 300.000. They sit on different tabs,
      so neither collapses -- but both carry "Pay all (2)", and the Transfer
      one also has the "Pay together" list inside its drawer.

  Undo with:  npx tsx --env-file=.env.development.local scripts/one-off/seed-pay-together.ts --clean`)
}

main().then(() => sql.end()).catch(async (err) => {
  console.error(err)
  await sql.end()
  process.exit(1)
})
