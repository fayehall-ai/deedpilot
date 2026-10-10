import { CalendarView } from "@/components/calendar-view";
import { Home } from "../_home/home";

/* Same ceiling as `/`, for the same server action. See `app/page.tsx`. */
export const maxDuration = 120;

/**
 * The home page with its calendar filtered — `/?state=FL`, `/?m=2026-11`.
 *
 * Request-time, because the filters are. Split from `/` so that the bare page,
 * which is what crawlers fetch, can be prerendered.
 * Filter links still point at `/`, so a chip keeps the reader where they are.
 * Readers and crawlers only reach it through the rewrite in `proxy.ts`, so the
 * URL they see, and the one search engines index, is `/?…`.
 */
export default function FilteredHomePage(props: PageProps<"/home-filtered">) {
  return <Home calendar={<CalendarView searchParams={props.searchParams} basePath="/" />} />;
}
