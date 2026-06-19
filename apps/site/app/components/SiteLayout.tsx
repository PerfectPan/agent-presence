import { Link, useLocation } from "react-router";
import { cn } from "~/lib/utils";
import {
  LOCALES,
  NAV_SECTIONS,
  type Locale,
  hrefFor,
  switchLocaleHref,
} from "~/lib/nav";

interface SiteLayoutProps {
  locale: Locale;
  children: React.ReactNode;
}

/**
 * App shell for documentation pages: top bar + sidebar + content + footer.
 * The landing page does NOT use this layout (it has its own full-bleed hero).
 */
export function SiteLayout({ locale, children }: SiteLayoutProps) {
  const location = useLocation();
  const currentPath = location.pathname;

  return (
    <div className="min-h-screen flex flex-col">
      <Header locale={locale} currentPath={currentPath} />
      <div className="flex flex-1 mx-auto w-full max-w-[var(--maxw,78rem)] gap-8 px-4 sm:px-6">
        <Sidebar locale={locale} currentPath={currentPath} />
        <main className="flex-1 min-w-0 py-8">{children}</main>
      </div>
      <Footer />
    </div>
  );
}

function Header({
  locale,
  currentPath,
}: {
  locale: Locale;
  currentPath: string;
}) {
  const home = hrefFor(locale, "");
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--background)]/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[var(--maxw,78rem)] items-center gap-4 px-4 sm:px-6">
        <Link to={home} className="flex items-center gap-2 font-mono text-sm">
          <span className="text-[var(--color-neon-green)]">$</span>
          <span className="font-semibold">agent-presence</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          {LOCALES.map((l) => (
            <Link
              key={l.code}
              to={switchLocaleHref(currentPath, l.code)}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                l.code === locale
                  ? "bg-[var(--muted)] text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
            >
              {l.label}
            </Link>
          ))}
          <a
            href="https://github.com/PerfectPan/agent-presence"
            className="ml-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--color-neon-blue)]"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

function Sidebar({
  locale,
  currentPath,
}: {
  locale: Locale;
  currentPath: string;
}) {
  return (
    <aside className="hidden md:block w-56 shrink-0 py-8">
      <nav className="sticky top-20 space-y-6 text-sm">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id}>
            <div className="mb-2 px-2 font-mono text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
              {section.label[locale]}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const href = hrefFor(locale, item.slug);
                const active = currentPath === href;
                return (
                  <li key={item.slug}>
                    <Link
                      to={href}
                      className={cn(
                        "block rounded-md px-2 py-1.5 transition-colors",
                        active
                          ? "bg-[var(--muted)] text-[var(--foreground)]"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                      )}
                    >
                      {item.label[locale]}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--border)] py-6">
      <div className="mx-auto w-full max-w-[var(--maxw,78rem)] px-4 sm:px-6 text-xs text-[var(--muted-foreground)]">
        <p>
          @rivus/agent-presence · v0.6.0 ·{" "}
          <a
            href="https://github.com/PerfectPan/agent-presence"
            className="underline hover:text-[var(--foreground)]"
          >
            source
          </a>{" "}
          ·{" "}
          <a
            href="https://www.npmjs.com/package/@rivus/agent-presence"
            className="underline hover:text-[var(--foreground)]"
          >
            npm
          </a>
        </p>
      </div>
    </footer>
  );
}
