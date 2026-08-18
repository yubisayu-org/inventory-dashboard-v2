import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import UploadClient from "./UploadClient"

export default function UploadShelfPage() {
  return (
    <PageShell>
      <PageHeader
        title="Upload shelves"
        subtitle="Full camera quality, straight into the system — no WhatsApp compression"
      />
      <UploadClient />
    </PageShell>
  )
}
