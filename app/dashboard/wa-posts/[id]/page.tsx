import PageShell from "@/components/PageShell"
import PostReviewClient from "./PostReviewClient"

export default async function WaPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <PageShell>
      <PostReviewClient postId={Number(id)} />
    </PageShell>
  )
}
