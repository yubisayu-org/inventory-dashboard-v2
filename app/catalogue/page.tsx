import CatalogueClient from "./CatalogueClient"

export default function CataloguePage() {
  return (
    <div className="min-h-screen bg-cream px-4 py-6 md:px-6 md:py-10">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Catalogue</h1>
          <p className="text-sm text-gray-500 mt-0.5">Browse, and tap Fix to request an item.</p>
        </div>
        <CatalogueClient />
      </div>
    </div>
  )
}
