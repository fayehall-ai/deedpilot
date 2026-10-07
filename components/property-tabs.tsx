"use client";

/**
 * The tab row under the summary strip. Panels are rendered on the server and
 * handed in; this only chooses which is visible, so switching tabs costs no
 * request and every panel is in the HTML for print and find-in-page.
 */
import { useState } from "react";

export function PropertyTabs({
  tabs,
}: {
  tabs: { id: string; label: string; panel: React.ReactNode }[];
}) {
  const [active, setActive] = useState(tabs[0]?.id);
  if (tabs.length === 0) return null;
  return (
    <div>
      <div
        role="tablist"
        className="flex gap-6 overflow-x-auto border-b border-border px-1 text-base font-medium"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={t.id === active}
            onClick={() => setActive(t.id)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 py-3 transition-colors ${
              t.id === active
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={t.id !== active} className="pt-4">
          {t.panel}
        </div>
      ))}
    </div>
  );
}
