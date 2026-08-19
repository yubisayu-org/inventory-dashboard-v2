"use client"

import { useEffect, useState, useCallback } from "react"
import CopyButton from "@/components/CopyButton"

type AccessRequest = {
  id: number
  instagramId: string
  note: string
  createdAt: string
  existingCustomerId: number | null
  existingCustomerAccess: string | null
}

type CatalogueCustomer = {
  id: number
  instagramId: string
  catalogueAccess: string
  boundAt: string | null
  orderCount: number
}

/** A link the shop copies and sends. Held in memory only — the token is stored
 *  as a hash, so once this is dismissed it can never be shown again. */
type IssuedLink = { instagramId: string; url: string }

const ACCESS_LABEL: Record<string, string> = {
  none: "Never invited",
  invited: "Invited, not signed in",
  active: "Signed in",
  revoked: "Revoked",
}

const ACCESS_CLASS: Record<string, string> = {
  none: "bg-gray-100 text-gray-600",
  invited: "bg-amber-50 text-amber-700",
  active: "bg-green-50 text-green-700",
  revoked: "bg-red-50 text-red-700",
}

function inviteUrl(token: string): string {
  return `${window.location.origin}/customer/login?invite=${token}`
}

export default function CatalogueAccessClient() {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [customers, setCustomers] = useState<CatalogueCustomer[]>([])
  const [links, setLinks] = useState<IssuedLink[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/catalogue-access", { cache: "no-store" })
      if (!res.ok) throw new Error("Failed to load")
      const data = await res.json()
      setRequests(data.requests)
      setCustomers(data.customers)
      setError("")
    } catch {
      setError("Couldn't load catalogue access. Reload to try again.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function decide(id: number, action: "approve" | "reject") {
    setBusy(`request-${id}`)
    setError("")
    try {
      const res = await fetch("/api/catalogue-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      if (action === "approve") {
        setLinks((prev) => [{ instagramId: data.instagramId, url: inviteUrl(data.token) }, ...prev])
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  async function issue(customerId: number, instagramId: string) {
    setBusy(`customer-${customerId}`)
    setError("")
    try {
      const res = await fetch("/api/catalogue-access/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setLinks((prev) => [{ instagramId, url: inviteUrl(data.token) }, ...prev])
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  async function bulkInvite() {
    if (
      !confirm(
        "Generate a sign-in link for every customer with catalogue orders who has never signed in?\n\n" +
          "This supersedes any link they already have, so links you sent earlier will stop working.",
      )
    ) {
      return
    }
    setBusy("bulk")
    setError("")
    try {
      const res = await fetch("/api/catalogue-access/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bulk: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setLinks(
        (data.invites as { instagramId: string; token: string }[]).map((i) => ({
          instagramId: i.instagramId,
          url: inviteUrl(i.token),
        })),
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  async function revoke(customerId: number, instagramId: string) {
    if (!confirm(`Revoke catalogue access for ${instagramId}? They will be signed out immediately.`)) {
      return
    }
    setBusy(`customer-${customerId}`)
    setError("")
    try {
      const res = await fetch("/api/catalogue-access/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      })
      if (!res.ok) throw new Error("Failed to revoke")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Links are shown once and never again — the token is stored hashed. */}
      {links.length > 0 && (
        <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              Sign-in links ({links.length})
            </h2>
            <p className="text-xs text-gray-500">
              Shown once. Copy and send them now — they cannot be retrieved later, only re-issued.
            </p>
            <button
              type="button"
              onClick={() => setLinks([])}
              className="ml-auto px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
            >
              Dismiss
            </button>
          </div>
          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {links.map((link) => (
              <div
                key={link.url}
                className="flex items-center gap-3 rounded-lg border border-cream-border px-3 py-2"
              >
                <span className="text-sm font-medium text-foreground shrink-0">
                  {link.instagramId}
                </span>
                <code className="text-xs text-gray-500 truncate flex-1">{link.url}</code>
                <CopyButton value={link.url} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Access requests ({requests.length})
          </h2>
          <button
            type="button"
            onClick={bulkInvite}
            disabled={busy !== null}
            className="ml-auto px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy === "bulk" ? "Generating…" : "Invite all existing customers"}
          </button>
        </div>

        {requests.length === 0 ? (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
            No pending requests.
          </div>
        ) : (
          <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
            {requests.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-cream-border last:border-b-0"
              >
                <span className="text-sm font-medium text-foreground">{r.instagramId}</span>
                {r.existingCustomerId ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                    Existing customer — re-issue
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    New customer
                  </span>
                )}
                <span className="text-xs text-gray-500 flex-1 min-w-0 truncate">{r.note}</span>
                <button
                  type="button"
                  onClick={() => decide(r.id, "approve")}
                  disabled={busy !== null}
                  className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
                >
                  Approve &amp; make link
                </button>
                <button
                  type="button"
                  onClick={() => decide(r.id, "reject")}
                  disabled={busy !== null}
                  className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
                >
                  Reject
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          Catalogue customers ({customers.length})
        </h2>
        {customers.length === 0 ? (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
            Nobody has catalogue orders or access yet.
          </div>
        ) : (
          <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
            {customers.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-cream-border last:border-b-0"
              >
                <span className="text-sm font-medium text-foreground">{c.instagramId}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    ACCESS_CLASS[c.catalogueAccess] ?? "bg-gray-100 text-gray-600"
                  }`}
                >
                  {ACCESS_LABEL[c.catalogueAccess] ?? c.catalogueAccess}
                </span>
                <span className="text-xs text-gray-500">
                  {c.orderCount} {c.orderCount === 1 ? "order" : "orders"}
                </span>
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => issue(c.id, c.instagramId)}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
                  >
                    {c.catalogueAccess === "none" ? "Send link" : "Re-issue link"}
                  </button>
                  {c.catalogueAccess !== "revoked" && (
                    <button
                      type="button"
                      onClick={() => revoke(c.id, c.instagramId)}
                      disabled={busy !== null}
                      className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
