import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from "react-router";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  // Derive <html lang> from the active locale so prerendered /zh/* pages are
  // labelled zh-CN (screen readers, translation, SEO) rather than English.
  const location = useLocation();
  const isZh = location.pathname === "/zh" || location.pathname.startsWith("/zh/");
  return (
    <html lang={isZh ? "zh-CN" : "en"} className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Display font pairing: Space Grotesk (characterful headings) + Inter
            (body) + JetBrains Mono (terminal). Preconnect for fast first paint. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="p-8">
      <h1>Something went wrong</h1>
      {isRouteErrorResponse(error) ? (
        <p>{error.status} {error.statusText}</p>
      ) : (
        <p>{error instanceof Error ? error.message : "Unknown error"}</p>
      )}
    </div>
  );
}

export const meta = () => [{ title: "Agent Presence" }];
