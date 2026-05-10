"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { EventRow } from "@/lib/db"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"

const EMPTY_FORM = { name: "", eta: "" }

const formInputCls = "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const modalInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

export default function EventsClient() {
  const [data, setData] = useState<EventRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editRow, setEditRow] = useState<EventRow | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/events")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load events")
      setData(json.rows as EventRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          eta: form.eta.trim(),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm(EMPTY_FORM)
      load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  function field(key: keyof typeof EMPTY_FORM) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  async function handleDelete(row: EventRow) {
    if (!confirm(`Delete event "${row.name}"? Orders using this event will be affected.`)) return
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<EventRow, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: "Event Name",
      filterFn: "textContains" as unknown as undefined,
      enableHiding: false,
      cell: ({ getValue }) => (
        <span className="font-medium">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "eta",
      header: "ETA",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-foreground" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? <span className="text-gray-400 text-xs whitespace-nowrap">{v}</span> : ""
      },
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? <span className="text-gray-400 text-xs whitespace-nowrap">{v}</span> : ""
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 80,
      cell: ({ row }) => (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditRow(row.original)}
            title="Edit"
            className="text-gray-400 hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => handleDelete(row.original)}
            title="Delete"
            className="text-gray-400 hover:text-red-500 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [])

  const refreshButton = (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
    >
      {loading ? "…" : "Refresh"}
    </button>
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Add form */}
      <form onSubmit={handleAdd} className="rounded-xl border border-cream-border bg-white p-5 flex flex-col gap-4">
        <div className="text-sm font-semibold text-foreground">Add Event</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            {...field("name")}
            placeholder="Event name"
            required
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("eta")}
            placeholder="ETA (e.g. 2026-06-15)"
            disabled={adding}
            className={formInputCls}
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {adding ? "Saving…" : "Add"}
          </button>
        </div>
      </form>

      {/* Data grid */}
      {loading && <div className="text-sm text-gray-400 py-12 text-center">Loading…</div>}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <DataGrid
          data={data}
          columns={columns}
          pageSize={25}
          searchPlaceholder="Search events…"
          toolbarExtra={refreshButton}
          getRowId={(row) => String(row.id)}
          initialVisibility={{ createdAt: false, updatedAt: false }}
          initialSorting={[{ id: "name", desc: false }]}
        />
      )}

      {/* Edit modal */}
      {editRow && (
        <EditEventModal
          row={editRow}
          onSave={(updated) => {
            setData((prev) =>
              prev?.map((r) => r.id === editRow.id ? { ...r, ...updated } : r) ?? null
            )
            setEditRow(null)
          }}
          onCancel={() => setEditRow(null)}
        />
      )}
    </div>
  )
}

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditEventModal({
  row,
  onSave,
  onCancel,
}: {
  row: EventRow
  onSave: (updated: Partial<EventRow>) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState({
    name: row.name,
    eta: row.eta,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

  function draftField(key: keyof typeof draft) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
      disabled: saving,
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          eta: draft.eta.trim(),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSave({
        name: draft.name.trim(),
        eta: draft.eta.trim(),
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); handleSave() }
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-md flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Edit Event</span>
          <span className="text-xs text-gray-400">ID: {row.id}</span>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Event Name</span>
            <input
              ref={firstInputRef}
              {...draftField("name")}
              onKeyDown={handleKeyDown}
              placeholder="Event name"
              className={modalInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">ETA</span>
            <input
              {...draftField("eta")}
              onKeyDown={handleKeyDown}
              placeholder="ETA (e.g. 2026-06-15)"
              className={modalInputCls}
            />
          </label>
        </div>

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
