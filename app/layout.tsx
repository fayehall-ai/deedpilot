import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { cacheLife } from "next/cache";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "DeedPilot — tax deed auction intelligence",
    template: "%s · DeedPilot",
  },
  description:
    "Every county's tax sale rules, live auction inventory, and a bidding co-pilot that tells you your walk-away price before you raise the paddle.",
};

/**
 * Mostly sections of the home page, in the order they appear there.
 *
 * Ordered by how often each is looked at rather than alphabetically or by
 * marketing logic: the calendar is what a subscriber opens daily, pricing is
 * read once. That order is also the order the sections appear in, because an
 * anchor nav whose order disagrees with the page reads as broken.
 *
 * Each anchored item still has a real route (`/calendar`, `/atlas`, …) —
 * anchors are for moving around the page, routes are for deep links, sharing,
 * and the search engines that index the 1,010 county pages.
 *
 * Auctions is the exception, and points at its route. The home page used to
 * carry the same sales twice, as a calendar and as a list below it; the list
 * came out once the calendar could show lots and opening bids on its own. The
 * route stays because a flat list is still the better view for scanning a whole
 * season at once, and there is no longer a section for the anchor to reach.
 */
const NAV = [
  { href: "/#calendar", label: "Calendar" },
  { href: "/auctions", label: "Auctions" },
  { href: "/#atlas", label: "Atlas" },
  { href: "/#coverage", label: "Coverage" },
  { href: "/#pricing", label: "Pricing" },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span
                aria-hidden
                className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm font-bold text-accent-fg"
              >
                §
              </span>
              DeedPilot
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-md px-3 py-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-border bg-surface-2/50">
          <div className="mx-auto max-w-7xl px-4 py-8 text-xs leading-relaxed text-muted sm:px-6">
            <p className="mb-2 max-w-3xl">
              <strong className="text-foreground">Not legal or investment advice.</strong> Tax sale
              rules vary by state, county, and municipality, and change with legislation. Auction
              inventory, opening bids, and statutory figures here are compiled from public records
              and may be stale or incomplete. Confirm everything with the county treasurer, tax
              collector, or clerk of court — and with an attorney — before bidding.
            </p>
            <p>
              © <CopyrightYear /> DeedPilot
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

/**
 * The copyright year, cached for a day.
 *
 * Under Cache Components a Server Component may not read the clock while it
 * prerenders — the value would be frozen into 1,061 static atlas pages at
 * build time and silently go stale on January 1st. A cached component is the
 * sanctioned answer: the year is computed inside the cache scope and expires
 * on its own, so the surrounding shell stays fully static and prefetchable.
 */
async function CopyrightYear() {
  "use cache";
  cacheLife("days");
  return <>{new Date().getFullYear()}</>;
}
