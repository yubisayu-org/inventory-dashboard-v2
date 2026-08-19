"use client"

/**
 * Placeholder for Task 9. `ComposerFlow` (in CataloguePostsClient.tsx) hands
 * off here once the upload step (Task 8) has created a real `wa_sends` row —
 * `sendId` and `mediaUrl` are always real; `prefillFromPostId` is set only
 * for the "Pakai post lama" path and tells this step which past post's
 * `catalogue_post_products` to pre-attach (via a loop of
 * `POST /api/whatsapp/sends/[id]/products`, one call per product — no route
 * currently exists to fetch a post's tagged products in one shot, so Task 9
 * will need to add one, e.g. `GET /api/whatsapp/sends/[id]/tagged-products`
 * or similar, reading `catalogue_post_products` for `send.postId`).
 *
 * Task 9 replaces this file's contents with the real product-tagging step
 * (pin placement on the photo, product search/attach, code assignment,
 * "Send" trigger) but should keep this exact prop shape — the composer flow
 * and both upload-step tabs already depend on it.
 */
export default function ComposerProductStep({
  sendId,
  mediaUrl,
  prefillFromPostId,
  onDone,
}: {
  sendId: number
  mediaUrl: string
  prefillFromPostId?: number
  onDone: () => void
}) {
  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Product step (coming soon)</h2>
      <p className="text-xs text-gray-500">
        Send #{sendId} created{prefillFromPostId ? ` from post #${prefillFromPostId}` : ""}. Product tagging isn't
        built yet.
      </p>
      <img src={mediaUrl} alt="" className="w-32 h-32 object-cover rounded-lg" />
      <button
        onClick={onDone}
        className="self-start px-3 py-1.5 rounded-lg border border-cream-border text-sm"
      >
        Back to posts
      </button>
    </div>
  )
}
