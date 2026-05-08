# Yubisayu Inventory Dashboard — Codebase Guide

An inventory management system for tracking orders from input through purchasing, arrival, shipping, and invoicing. Built with Next.js 16, Supabase (PostgreSQL), and NextAuth.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Dashboard Pages│  │  Components  │  │ React Hooks  │ │
│  │  (app/dashboard)  │  (components/)│  │  (hooks/)    │ │
│  └───────┬───────┘  └──────────────┘  └──────┬───────┘ │
│          │              fetch()               │         │
└──────────┼────────────────────────────────────┼─────────┘
           ▼                                    ▼
┌─────────────────────────────────────────────────────────┐
│                    Next.js Server                       │
│  ┌──────────────────────┐  ┌─────────────────────────┐  │
│  │  middleware.ts        │  │  API Routes             │  │
│  │  (auth + role check)  │  │  (app/api/sheets/*)     │  │
│  └──────────────────────┘  └───────────┬─────────────┘  │
│                                        │                │
│  ┌──────────────┐  ┌──────────────┐    │                │
│  │  lib/api.ts   │  │  lib/roles.ts│    │                │
│  │  (requireSession, requireRole)  │    │                │
│  └──────────────┘  └──────────────┘    │                │
│                                        ▼                │
│  ┌──────────────────────────────────────────────────┐   │
│  │              lib/db.ts  (data layer)              │   │
│  │  40+ functions · same interfaces for all routes   │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │         lib/db-pool.ts  (postgres driver)         │   │
│  └──────────────────────┬───────────────────────────┘   │
└─────────────────────────┼───────────────────────────────┘
                          │  SSL connection
                          ▼
                 ┌─────────────────┐
                 │    Supabase     │
                 │   PostgreSQL    │
                 │  (7 tables)     │
                 └─────────────────┘
```

---

## Database Schema

```
┌──────────────┐     ┌──────────────────────────────────────────┐
│   events     │     │                 orders                    │
│──────────────│     │──────────────────────────────────────────│
│ id      PK   │◄────│ event          (event name)              │
│ name  UNIQUE │     │ id         PK                            │
└──────────────┘     │ customer       (instagram handle)        │
                     │ items, unit    (what & how many)         │
┌──────────────┐     │ note                                     │
│  customers   │     │ unit_buy       ← Stage 2 (Purchasing)   │
│──────────────│     │ receipt        ← Stage 2                 │
│ id       PK  │     │ unit_arrive    ← Stage 3 (Arrive)       │
│ instagram_id │◄────│ unit_ship      ← Stage 4 (Ship)         │
│ whatsapp     │     │ unit_hold      ← Stage 4                │
│ data_diri    │     │ created_at, updated_at                   │
│ ekspedisi    │     └──────────────────────────────────────────┘
│ ongkos_kirim │
└──────────────┘     ┌──────────────────────────────────────────┐
                     │             shipments                     │
┌──────────────┐     │──────────────────────────────────────────│
│  products    │     │ id         PK                            │
│──────────────│     │ shipping_id    UNIQUE (auto "0001")      │
│ id       PK  │     │ event, customer                          │
│ name         │     │ invoicing      (line items text)         │
│ store        │     │ weight_estimation, ongkir, ongkir_total  │
│ price        │     │ is_last_shipment                         │
└──────────────┘     │ tracking_number                          │
                     │ created_at, updated_at                   │
┌──────────────┐     └──────────────────────────────────────────┘
│products_indo │
│──────────────│     ┌──────────────────────────────────────────┐
│ id       PK  │     │          excess_purchase                  │
│ product      │     │──────────────────────────────────────────│
│ store        │     │ id         PK                            │
│ price        │     │ event, items                             │
└──────────────┘     │ unit_buy, receipt                        │
                     │ created_at, updated_at                   │
                     └──────────────────────────────────────────┘
```

---

## Order Lifecycle

An order flows through 4 stages. Each stage updates different columns on the `orders` table.

```
 Stage 1: INPUT              Stage 2: PURCHASING         Stage 3: ARRIVE           Stage 4: SHIP
 (/duplicate-form)           (/purchasing)               (/arrive)                 (/ship)
 ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐       ┌─────────────────┐
 │ Customer places  │         │ Admin buys items │         │ Items arrive at │       │ Pack & ship to  │
 │ order            │────────▶│ from stores      │────────▶│ warehouse       │──────▶│ customer        │
 │                  │         │                  │         │                 │       │                 │
 │ Sets:            │         │ Sets:            │         │ Sets:           │       │ Sets:           │
 │  event           │         │  unit_buy        │         │  unit_arrive    │       │  unit_ship      │
 │  customer        │         │  receipt         │         │                 │       │  unit_hold      │
 │  items           │         │                  │         │                 │       │                 │
 │  unit            │         │                  │         │                 │       │ Creates:        │
 │  note            │         │                  │         │                 │       │  shipment record│
 └─────────────────┘         └─────────────────┘         └─────────────────┘       └────────┬────────┘
                                                                                            │
                                                                                            ▼
                                                                                   ┌─────────────────┐
                                                                                   │ SHIPMENTS        │
                                                                                   │ (/shipments)     │
                                                                                   │                  │
                                                                                   │ Add tracking     │
                                                                                   │ number, print    │
                                                                                   │ shipping labels  │
                                                                                   └────────┬────────┘
                                                                                            │
                                                                                            ▼
                                                                                   ┌─────────────────┐
                                                                                   │ INVOICE          │
                                                                                   │ (/invoice)       │
                                                                                   │                  │
                                                                                   │ Computed from    │
                                                                                   │ orders + products│
                                                                                   │ + shipments      │
                                                                                   └─────────────────┘
```

---

## Directory Structure

```
inventory-dashboard-v2/
│
├── app/
│   ├── layout.tsx                    # Root layout (fonts, metadata)
│   ├── login/page.tsx                # Google OAuth sign-in page
│   │
│   ├── dashboard/
│   │   ├── page.tsx                  # Home (placeholder)
│   │   ├── layout.tsx                # Dashboard shell with sidebar
│   │   ├── duplicate-form/           # Stage 1 — Input & edit orders
│   │   ├── purchasing/               # Stage 2 — Distribute purchases
│   │   ├── arrive/                   # Stage 3 — Mark items arrived
│   │   ├── ship/                     # Stage 4 — Ship to customer
│   │   ├── shipments/                # View shipments & tracking
│   │   ├── form-records/             # Read-only order records view
│   │   ├── invoice/                  # Invoice generation per customer
│   │   ├── excess-purchase/          # Manage excess inventory
│   │   ├── products/                 # Product catalog (owner only)
│   │   └── custom-label/             # Manual shipping label generator
│   │
│   └── api/
│       ├── auth/[...nextauth]/       # NextAuth handler
│       └── sheets/                   # Data API (all require auth)
│           ├── options/              # GET  → events, items, customers
│           ├── orders/               # POST → append new orders
│           ├── duplicate-form/       # GET  → paginated orders list
│           ├── duplicate-form/[row]/ # POST/PATCH/DELETE single order
│           ├── purchasing/           # POST → bulk update unit_buy
│           ├── arrive/               # POST → bulk update unit_arrive
│           ├── ship/                 # GET/POST → ship orders
│           ├── shipments/            # GET/PATCH → shipment records
│           ├── excess-purchase/      # GET/POST → excess inventory
│           ├── excess-purchase/[row]/# DELETE
│           ├── invoice/              # GET  → computed invoice data
│           ├── customer/             # GET  → customer lookup
│           └── products-indo/        # GET/POST/PATCH/DELETE
│
├── lib/
│   ├── db.ts                # Data layer — all SQL queries (40+ functions)
│   ├── db-pool.ts           # PostgreSQL connection pool (postgres driver)
│   ├── api.ts               # Auth helpers (requireSession, requireRole, requireOwner)
│   ├── roles.ts             # Role assignment from env vars (owner/admin)
│   ├── shipping-label.ts    # PDF label generation (jsPDF)
│   ├── clipboard.ts         # Copy-to-clipboard utility
│   └── auth-actions.ts      # Server action: sign out
│
├── hooks/
│   ├── usePaginatedFetch.ts # Server-side pagination with debounced search
│   ├── useSheetOptions.ts   # Load dropdown options (events/items/customers)
│   ├── useCopyFeedback.ts   # Copy with visual feedback
│   ├── useModalDismiss.ts   # Escape key + scroll lock for modals
│   └── useResizableColumns.ts # Draggable column widths
│
├── components/
│   ├── SearchableSelect.tsx # Searchable dropdown with keyboard nav
│   ├── Pagination.tsx       # Page buttons + jump-to-page input
│   ├── PageShell.tsx        # Layout wrapper with sidebar
│   ├── PageHeader.tsx       # Title bar
│   └── SidebarClient.tsx    # Navigation sidebar
│
├── supabase/
│   └── schema.sql           # Database schema (7 tables + indexes)
│
├── auth.ts                  # NextAuth config (Google provider)
├── middleware.ts             # Route protection (auth + role checks)
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

---

## Authentication & Authorization

```
                    Request to /dashboard/*
                            │
                            ▼
                    ┌───────────────┐
                    │ middleware.ts  │
                    │               │
                    │ Has session?  │──── No ───▶ Redirect to /login
                    │               │
                    └───────┬───────┘
                            │ Yes
                            ▼
                    ┌───────────────┐
                    │ Has role?     │──── No ───▶ Redirect to /login?error=unauthorized
                    │ (owner/admin) │
                    └───────┬───────┘
                            │ Yes
                            ▼
                    ┌───────────────┐
                    │ /products     │──── admin ─▶ Redirect (owner only)
                    │ owner-only?   │
                    └───────┬───────┘
                            │ allowed
                            ▼
                      Render page
```

**Roles** are assigned by matching the user's Google email against environment variables:

| Role    | Env Var        | Permissions                    |
|---------|----------------|--------------------------------|
| `owner` | `OWNER_EMAILS` | All features + product catalog |
| `admin` | `ADMIN_EMAILS` | All features except products   |

Each API route additionally checks auth via `requireSession()` and `requireRole()`.

---

## Data Flow: How Pages Talk to the Database

Every dashboard page follows the same pattern:

```
  Page Component                API Route                 lib/db.ts              Supabase
  ─────────────                ──────────                ──────────             ─────────
       │                           │                         │                      │
       │── fetch("/api/sheets/…") ─▶                         │                      │
       │                           │── requireSession() ────▶│                      │
       │                           │── requireRole() ───────▶│                      │
       │                           │── db.someFunction() ───▶│                      │
       │                           │                         │── sql`SELECT …` ────▶│
       │                           │                         │◀── rows ────────────│
       │                           │◀── typed result ───────│                      │
       │◀── JSON response ────────│                         │                      │
       │                           │                         │                      │
```

No page imports `lib/db.ts` directly — all data access goes through API routes.

---

## Key Features

### Server-Side Pagination (duplicate-form, form-records)

Tables with many rows use server-side pagination with debounced search:

```
  User types in search box
          │
          │ (300ms debounce)
          ▼
  usePaginatedFetch hook
          │
          │ GET /api/sheets/duplicate-form
          │     ?page=1&pageSize=25
          │     &search=keyword
          │     &event=EventName
          │     &sortKey=items&sortDir=asc
          ▼
  getDuplicateFormRowsPaginated()
          │
          │ Single SQL query with:
          │   WHERE (dynamic filters)
          │   ORDER BY (dynamic sort)
          │   LIMIT/OFFSET
          │   COUNT(*) OVER() ← total in same query
          ▼
  Returns { rows, totalCount, totalPages }
```

### Ship Page Segments

The ship page groups orders by customer+event and categorizes them:

```
  ┌──────────────────────────────────────────────────────────┐
  │  [ Semua ]  [ Belum Tiba ]  [ Siap Dikirim ]  [ Sudah ] │
  └──────────────────────────────────────────────────────────┘

  Belum Tiba (not_arrived):  ALL orders have unit_arrive = 0
  Siap Dikirim (ready):      totalToShip > 0  (arrived but not fully shipped)
  Sudah Dikirim (shipped):   totalToShip = 0  (everything shipped)
```

Filtering happens server-side via `getShipOrdersFiltered()`. Segment counts are computed in a single aggregation query so badges are always accurate.

### Invoice Calculation

Invoices are computed on-the-fly (no stored table):

```
  GET /api/sheets/invoice?customer=@handle
          │
          ▼
  getInvoiceForCustomer()
          │
          ├── Fetch orders WHERE customer = handle
          ├── Fetch product prices
          ├── Fetch shipments WHERE customer = handle
          │
          ▼
  For each event:
    order lines   = items × price × unit
    subtotal      = sum of line totals
    shipping cost = weight × ongkir_per_kg (per shipment)
    balance       = subtotal + total_shipping
```

### Shipping Labels (PDF)

Generated client-side using jsPDF (78mm × 100mm label format):

```
  ┌────────────────────────────────┐
  │ Event Name          #0042     │  ← event + shipping ID
  │                                │
  │ CUSTOMER_NAME                  │
  │ Full address from data_diri    │
  │ ...                            │
  │                                │
  │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
  │ Packing list:                  │
  │  Item A x 2                    │
  │  Item B x 1                    │
  │                                │
  │ Sender: Yubisayu               │
  └────────────────────────────────┘
```

---

## Environment Variables

| Variable                  | Purpose                                |
|---------------------------|----------------------------------------|
| `DATABASE_URL`            | Supabase PostgreSQL connection string  |
| `GOOGLE_CLIENT_ID`        | Google OAuth client ID                 |
| `GOOGLE_CLIENT_SECRET`    | Google OAuth client secret             |
| `NEXTAUTH_SECRET`         | Session encryption key                 |
| `OWNER_EMAILS`            | Comma-separated owner email addresses  |
| `ADMIN_EMAILS`            | Comma-separated admin email addresses  |

---

## Tech Stack

| Layer      | Technology                          |
|------------|-------------------------------------|
| Framework  | Next.js 16 (App Router)             |
| Language   | TypeScript 5 (strict mode)          |
| Database   | PostgreSQL via Supabase              |
| DB Driver  | `postgres` (porsager) — raw SQL      |
| Auth       | NextAuth v5 (Google OAuth)           |
| Styling    | Tailwind CSS 4                       |
| PDF        | jsPDF                                |
| Deployment | Netlify (serverless functions)       |
