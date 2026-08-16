import { test } from "node:test"
import assert from "node:assert/strict"
import { statSync } from "node:fs"
import { FIXTURES } from "./fixtures"

test("every fixture path points at a real, non-empty file", () => {
  for (const [name, path] of Object.entries(FIXTURES)) {
    const stat = statSync(path)
    assert.ok(stat.isFile(), `${name} is not a file: ${path}`)
    assert.ok(stat.size > 1000, `${name} is suspiciously small: ${stat.size} bytes`)
  }
})
