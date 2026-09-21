import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { HomeLink } from "@/components/home-link";
import { Fraunces, IBM_Plex_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { cacheLife } from "next/cache";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  display: "swap",
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
});

const plex = IBM_Plex_Mono({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

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
 * Auctions was here and is not any more. A visitor asking "what is for sale"
 * almost always means "where", and answering it on a separate page meant
 * choosing a county on the map, leaving to see whether it had a sale, and coming
 * back to try another — a round trip per county.
 *
 * The sale list now sits under the map: collapsed while nothing is selected,
 * filtered to the county the moment one is. `/auctions` remains a real route for
 * deep links and for scanning a whole season flat, it simply is not the way in
 * any more.
 *
 * CAPE is deliberately not here. It is a production board for research and
 * operations rather than something a visitor is looking for, and it is reached
 * from /coverage, which is where the rest of the data-health surface lives.
 */
const NAV = [
  { href: "/#calendar", label: "Calendar" },
  { href: "/#atlas", label: "Atlas" },
  { href: "/#pricing", label: "Pricing" },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${fraunces.variable} ${plex.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        {/*
          The bar belongs to the ink band, not above it.
          
          A white header sitting on a dark hero looked like two pages stacked. Ink
          site-wide also solves the scroll problem a transparent header would have
          created — no colour has to change as the light content passes under it.
        */}
        <header className="sticky top-0 z-40 border-b border-ink-line bg-ink/80 text-ink-fg backdrop-blur-xl">
          {/*
            The logo plus five nav items need 551px of intrinsic width, and
            this row was `flex-wrap: nowrap` with visible overflow — so on a
            375px phone it pushed 176px past the viewport and every page in the
            site scrolled sideways, the header dragging the body with it.

            The nav scrolls instead of wrapping: wrapping would break the 56px
            bar into two rows and push the page content down on exactly the
            screens with the least of it. `shrink-0` on the items is what makes
            the scroll work — without it flex compresses them into unreadable
            slivers rather than overflowing into a scrollable strip.
          */}
          <div className="shell flex h-[4.25rem] items-center gap-3 sm:gap-6">
            <HomeLink className="flex shrink-0 items-center gap-2.5 font-display text-xl font-semibold tracking-tight">
              <Image
                src="/brand/tdc-logo.png"
                alt=""
                width={32}
                height={32}
                className="h-8 w-8"
                priority
              />
              DeedPilot
            </HomeLink>
            <nav
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-base [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              aria-label="Primary"
            >
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="shrink-0 rounded-full px-3.5 py-1.5 text-ink-muted transition-colors hover:bg-white/10 hover:text-ink-fg"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-border bg-surface-2/50">
          <div className="shell py-band text-sm leading-relaxed text-muted">
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
