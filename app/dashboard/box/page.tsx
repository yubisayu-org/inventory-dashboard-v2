import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import BoxManifestClient from "./BoxManifestClient"

export default function BoxPage() {
  return (
    <PageShell>
      <PageHeader
        title="Box Manifest"
        subtitle="What was packed in a parcel, against who was served out of it"
      />
      <BoxManifestClient />
    </PageShell>
  )
}
