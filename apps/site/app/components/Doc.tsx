import { Prose } from "./Prose";
import { SiteLayout } from "./SiteLayout";
import type { Locale } from "~/lib/nav";

/**
 * Standard documentation page shell: wraps content in SiteLayout + Prose and
 * stamps the "distilled from <source>" note when provided.
 */
export function Doc({
  locale,
  title,
  source,
  children,
}: {
  locale: Locale;
  title: string;
  source?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <SiteLayout locale={locale}>
      <Prose>
        <h1>{title}</h1>
        {source ? (
          <blockquote className="not-prose my-2 rounded-md border-l-2 border-[var(--color-neon-blue)] bg-[var(--muted)]/40 px-4 py-2 text-sm text-[var(--muted-foreground)]">
            <em>Distilled from {source}. English README is the single source of truth.</em>
          </blockquote>
        ) : null}
        {children}
      </Prose>
    </SiteLayout>
  );
}

/** Inline note callout. */
export function Note({
  title = "Note",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="not-prose my-4 rounded-lg border border-[var(--color-neon-blue-soft)] bg-[color-mix(in_srgb,var(--color-neon-blue-soft)_14%,transparent)] p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-neon-blue)]">
        {title}
      </div>
      <div className="text-sm leading-6 text-[var(--foreground)]">{children}</div>
    </div>
  );
}

/** Inline caution callout. */
export function Caution({
  title = "Caution",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="not-prose my-4 rounded-lg border border-[var(--color-neon-amber-soft)] bg-[color-mix(in_srgb,var(--color-neon-amber-soft)_14%,transparent)] p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-neon-amber)]">
        {title}
      </div>
      <div className="text-sm leading-6 text-[var(--foreground)]">{children}</div>
    </div>
  );
}
