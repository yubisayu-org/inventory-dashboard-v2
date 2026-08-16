import PageShell from "@/components/PageShell"
import ShopPostClient from "./ShopPostClient"

export default async function ShopPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <PageShell>
      <ShopPostClient postId={Number(id)} />
    </PageShell>
  )
}
