import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { auth } from "@/auth"
import CustomersClient from "./CustomersClient"

export default async function CustomersPage() {
  // The four address fields are read-only for staff — a district typed by hand
  // that the rates table does not recognise prices a parcel at nothing, and
  // says so nowhere. Only the owner can unlock them.
  const session = await auth()
  const role = session?.user?.role ?? null

  return (
    <PageShell>
      <PageHeader
        title="Customers"
        subtitle="View, add, and edit customer detail"
      />
      <CustomersClient role={role} />
    </PageShell>
  )
}
