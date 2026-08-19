import sql from "../db-pool"
import { normalizeId } from "./helpers"
import { issueInvite } from "./catalogue-auth"

// Staff-side reads and writes for catalogue access. Everything here runs on
// the main pool; catalogue_public has no part in any of it.

export type AccessRequestRow = {
  id: number
  instagramId: string
  note: string
  createdAt: string
  /** Non-null when this handle already has a customers row — a re-issue, not a
   *  new account. Two rows for one person would split their order history. */
  existingCustomerId: number | null
  existingCustomerAccess: string | null
}

export async function listPendingAccessRequests(): Promise<AccessRequestRow[]> {
  const rows = await sql<
    {
      id: number
      instagram_id: string
      note: string
      created_at: Date
      existing_customer_id: number | null
      existing_customer_access: string | null
    }[]
  >`
    SELECT r.id, r.instagram_id, r.note, r.created_at,
           c.id               AS existing_customer_id,
           c.catalogue_access AS existing_customer_access
      FROM catalogue_access_requests r
      LEFT JOIN customers c
        ON lower(replace(c.instagram_id, '@', ''))
         = lower(replace(r.instagram_id, '@', ''))
     WHERE r.status = 'pending'
     ORDER BY r.created_at DESC
  `
  return rows.map((r) => ({
    id: r.id,
    instagramId: r.instagram_id,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    existingCustomerId: r.existing_customer_id,
    existingCustomerAccess: r.existing_customer_access,
  }))
}

/**
 * Approve an access request and return the invite token to send them.
 *
 * Matches an existing customer by normalised handle rather than creating one
 * blindly: a second row for someone who has ordered before would split their
 * history across two accounts, and the whole point of the invite is to reach
 * the history they already have.
 */
export async function approveAccessRequest(
  requestId: number,
): Promise<{ customerId: number; instagramId: string; token: string }> {
  const customer = await sql.begin(async (tx) => {
    const [req] = await tx<{ instagram_id: string; status: string }[]>`
      SELECT instagram_id, status FROM catalogue_access_requests
       WHERE id = ${requestId} FOR UPDATE
    `
    if (!req) throw new Error("Access request not found")
    if (req.status !== "pending") throw new Error("Access request already handled")

    const handle = normalizeId(req.instagram_id)
    const [existing] = await tx<{ id: number; instagram_id: string }[]>`
      SELECT id, instagram_id FROM customers
       WHERE lower(replace(instagram_id, '@', '')) = ${handle}
    `
    const row =
      existing ??
      (
        await tx<{ id: number; instagram_id: string }[]>`
          INSERT INTO customers (instagram_id) VALUES (${handle})
          RETURNING id, instagram_id
        `
      )[0]

    await tx`
      UPDATE catalogue_access_requests
         SET status = 'approved', decided_at = NOW(), customer_id = ${row.id}
       WHERE id = ${requestId}
    `
    return row
  })

  // Outside the transaction: issueInvite opens its own, and nesting them would
  // deadlock on the same connection.
  const token = await issueInvite(customer.id)
  return { customerId: customer.id, instagramId: customer.instagram_id, token }
}

export async function rejectAccessRequest(requestId: number): Promise<void> {
  const rows = await sql`
    UPDATE catalogue_access_requests
       SET status = 'rejected', decided_at = NOW()
     WHERE id = ${requestId} AND status = 'pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Access request not found or already handled")
}

export type CatalogueCustomerRow = {
  id: number
  instagramId: string
  catalogueAccess: string
  boundAt: string | null
  orderCount: number
}

/** Everyone with catalogue order history or catalogue access, for the admin list. */
export async function listCatalogueCustomers(): Promise<CatalogueCustomerRow[]> {
  const rows = await sql<
    {
      id: number
      instagram_id: string
      catalogue_access: string
      bound_at: Date | null
      order_count: string
    }[]
  >`
    SELECT c.id, c.instagram_id, c.catalogue_access, c.bound_at,
           COUNT(r.id) AS order_count
      FROM customers c
      LEFT JOIN catalogue_requests r ON r.customer_id = c.id
     GROUP BY c.id
    HAVING COUNT(r.id) > 0 OR c.catalogue_access <> 'none'
     ORDER BY c.instagram_id
  `
  return rows.map((r) => ({
    id: r.id,
    instagramId: r.instagram_id,
    catalogueAccess: r.catalogue_access,
    boundAt: r.bound_at ? r.bound_at.toISOString() : null,
    orderCount: Number(r.order_count),
  }))
}

/**
 * Invites for everyone with catalogue order history who has never signed in.
 *
 * The migration run: these are the people who would otherwise hit a sign-in
 * wall with no way past it.
 */
export async function bulkInviteExistingCustomers(): Promise<
  { instagramId: string; token: string }[]
> {
  const rows = await sql<{ id: number; instagram_id: string }[]>`
    SELECT DISTINCT c.id, c.instagram_id
      FROM customers c
      JOIN catalogue_requests r ON r.customer_id = c.id
     WHERE c.google_sub IS NULL
       AND c.catalogue_access <> 'revoked'
     ORDER BY c.instagram_id
  `
  const out: { instagramId: string; token: string }[] = []
  for (const row of rows) {
    out.push({ instagramId: row.instagram_id, token: await issueInvite(row.id) })
  }
  return out
}
