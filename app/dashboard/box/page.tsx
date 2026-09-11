import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import BoxManifestClient from "./BoxManifestClient"

export default function BoxPage() {
  return (
    <PageShell>
      <PageHeader
        title="Manifest"
        subtitle="What was packed in a parcel, against what has been counted back in"
      />
      <BoxManifestClient />
    </PageShell>
  )
}
