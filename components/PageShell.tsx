import Sidebar from "@/components/Navbar"
import MobileNav from "@/components/MobileNav"

interface Props {
  children: React.ReactNode
  narrow?: boolean
}

export default function PageShell({ children, narrow = false }: Props) {
  return (
    <div className="flex min-h-screen bg-cream">
      {/* Desktop sidebar — hidden on mobile, replaced by the bottom nav */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <main className={`flex-1 min-w-0 ${narrow ? "max-w-3xl" : ""} px-4 py-6 pb-24 md:px-6 md:py-10 md:pb-10`}>
        {children}
      </main>
      <MobileNav />
    </div>
  )
}
