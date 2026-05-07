"use client"

import { useCallback, useEffect, useRef, useState } from "react"

type Filters = { event: string; customer: string; items: string }
type SortConfig = { key: string; direction: "asc" | "desc" } | null

export type PageData = {
  rows: unknown[]
  totalCount: number
  totalPages: number
  page: number
}

type FetchState = {
  loading: boolean
  error: string
  refreshError: string
}

const INITIAL_FETCH_STATE: FetchState = { loading: true, error: "", refreshError: "" }

export function usePaginatedFetch(opts: {
  endpoint: string
  pageSize: number
  page: number
  search: string
  filters: Filters
  sort: SortConfig
  onData: (data: PageData) => void
}) {
  const { endpoint, pageSize, page, search, filters, sort, onData } = opts
  const [fetchState, setFetchState] = useState<FetchState>(INITIAL_FETCH_STATE)
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  const fetchPage = useCallback(async (
    p: number,
    s: string,
    f: Filters,
    so: SortConfig,
    isRefresh = false,
  ) => {
    setFetchState((prev) => ({ ...prev, loading: !isRefresh, refreshError: "" }))
    const params = new URLSearchParams()
    params.set("page", String(p))
    params.set("pageSize", String(pageSize))
    if (s) params.set("search", s)
    if (f.event) params.set("event", f.event)
    if (f.customer) params.set("customer", f.customer)
    if (f.items) params.set("items", f.items)
    if (so) {
      params.set("sortKey", so.key)
      params.set("sortDir", so.direction)
    } else {
      params.set("newestFirst", "true")
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(`${endpoint}?${params}`, { signal: controller.signal, cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load rows")
      onDataRef.current(data)
      setFetchState({ loading: false, error: "", refreshError: "" })
    } catch (err) {
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? "Request timed out — please retry"
          : err instanceof Error ? err.message : "Failed to load rows"
      if (isRefresh) setFetchState((prev) => ({ ...prev, loading: false, refreshError: msg }))
      else setFetchState({ loading: false, error: msg, refreshError: "" })
    } finally {
      clearTimeout(timer)
    }
  }, [endpoint, pageSize])

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)
  const prevSearch = useRef(search)
  const prevPage = useRef(page)
  const prevFilters = useRef(filters)
  const prevSort = useRef(sort)

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      fetchPage(page, search, filters, sort)
      return
    }

    const searchChanged = prevSearch.current !== search
    const otherChanged = prevPage.current !== page || prevFilters.current !== filters || prevSort.current !== sort

    prevSearch.current = search
    prevPage.current = page
    prevFilters.current = filters
    prevSort.current = sort

    if (searchChanged && !otherChanged) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = setTimeout(() => {
        fetchPage(1, search, filters, sort)
      }, 300)
      return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
    }

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    fetchPage(searchChanged ? 1 : page, search, filters, sort)
  }, [page, search, filters, sort, fetchPage])

  const refresh = useCallback(() => {
    fetchPage(page, search, filters, sort, true)
  }, [fetchPage, page, search, filters, sort])

  return { fetchState, fetchPage, refresh }
}
