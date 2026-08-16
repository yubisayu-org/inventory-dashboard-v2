import { test } from "node:test"
import assert from "node:assert/strict"
import { WA_POSTS_BUCKET, uploadPostImage, downloadPostImage } from "./storage"

test("an uploaded image comes back byte-identical", async () => {
  const body = Buffer.from("not really a jpeg, but bytes are bytes")
  const path = `test/${process.pid}-${process.hrtime.bigint()}.txt`

  await uploadPostImage(path, body, "text/plain")
  const roundTripped = await downloadPostImage(path)

  assert.equal(roundTripped.toString(), body.toString())
})

test("the bucket name is the one the migration created", () => {
  assert.equal(WA_POSTS_BUCKET, "wa-posts")
})
