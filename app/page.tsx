import { CachedCalendarView } from "@/components/calendar-view";
import { Home } from "./_home/home";

/*
 * The property lookup is a server action invoked from this route, so its ceiling
 * is this route's. A cold search is ~27s and has run past 45; the default is not
 * something to find out about from a reader seeing "This page couldn't load".
 * The action stops itself at 55s, well inside this.
 */
export const maxDuration = 120;

/**
 * The bare home page, prerendered whole.
 *
 * Nothing here reads the request, so the route builds to a static page that
 * revalidates on the shortest `cacheLife` inside it. It was dynamic only
 * because the calendar read `searchParams`, which meant every crawler hit
 * started a function and queried Neon. Filtered views (`/?state=FL`) still
 * work: `proxy.ts` rewrites them to `/home-filtered`.
 */
export default function HomePage() {
  return <Home calendar={<CachedCalendarView basePath="/" />} />;
}
