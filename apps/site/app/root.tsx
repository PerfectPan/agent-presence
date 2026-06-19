import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
