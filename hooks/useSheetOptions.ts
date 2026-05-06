"use client"

import { useEffect, useState } from "react"
import type { SheetOptions } from "@/lib/db"

export function useSheetOptions(): SheetOptions | null {
  const [options, setOptions] = useState<SheetOptions | null>(null)
  useEffect(() => {
    fetch("/api/sheets/options")
      .then((r) => r.json())
      .then((data: SheetOptions & { error?: string }) => {
        if (!data.error) setOptions(data)
      })
      .catch(() => {})
  }, [])
  return options
}
