"use client";

/**
 * The wordmark, which always returns you to the top.
 *
 * A plain `<Link href="/">` only half worked. From `/#pricing` Next treated it
 * as a navigation and scrolled up; from `/` with no hash it was a no-op, so
 * clicking the logo four thousand pixels down the page did nothing at all. That
 * is the one thing a wordmark is universally expected to do, and it behaved
 * differently depending on whether a hash happened to be in the URL.
 *
 * On any other route it stays an ordinary link and Next handles it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

/** A modified click means the reader wants a new tab — never intercept it. */
function opensElsewhere(e: React.MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function HomeLink({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <Link
      href="/"
      className={className}
      onClick={(e) => {
        if (pathname !== "/" || opensElsewhere(e)) return;
        e.preventDefault();
        /*
         * Instant, not smooth, for two reasons.
         *
         * Every other in-page jump on this site is a native anchor landing on a
         * `scroll-mt-16` offset, which is instant; animating only the wordmark
         * would make one control behave unlike the rest.
         *
         * And smooth is not dependable. Measured in a real browser here,
         * `behavior: "smooth"` moved the page zero pixels from 2,500 while
         * `"auto"` landed on 0 — the animation is skipped in some contexts and
         * fails silently when it is. A control whose whole job is "put me back
         * at the top" should not have a decorative mode that can quietly not
         * arrive.
         */
        window.scrollTo({ top: 0, behavior: "auto" });
        /*
         * Drop the hash so the URL agrees with where the page now is. Done with
         * replaceState rather than a navigation, so it does not add a history
         * entry that a Back press would have to walk through.
         */
        if (window.location.hash) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      }}
    >
      {children}
    </Link>
  );
}
