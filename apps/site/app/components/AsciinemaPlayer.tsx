import { useEffect, useRef } from "react";
// asciinema-player's CSS is required for the terminal to render (it provides
// the .asciinema-player layout/terminal styling). Imported at module load so
// Vite bundles it; otherwise the player mounts but renders invisibly.
import "asciinema-player/dist/bundle/asciinema-player.css";

/**
 * AsciinemaPlayer — renders a sanitized `.cast` file with asciinema-player.
 *
 * Security: `.cast` files are hand-written and sanitized (see
 * apps/site/scripts/README-casts.md). They contain NO real credentials — slot
 * ids are slot_xxx, tokens are <token>, transcript figures are illustrative.
 *
 * Accessibility: honors prefers-reduced-motion (autoplay off, controls shown,
 * playback paused) so nothing animates unexpectedly. The terminal content is a
 * decorative replay of read-only commands also documented in page text.
 *
 * Casts live in apps/site/public/casts/ and are fetched at runtime via the
 * given src (a root-relative URL like "/casts/quickstart.cast").
 */
export function AsciinemaPlayer({
  src,
  title = "Terminal replay",
  speed = 1,
}: {
  src: string;
  title?: string;
  speed?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<{ pause?: () => void; dispose?: () => void } | null>(
    null,
  );

  useEffect(() => {
    if (!mountRef.current) return;
    let disposed = false;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Dynamic import so the player is only loaded when a cast is on screen,
    // keeping the first paint light.
    import("asciinema-player")
      .then(({ create }) => {
        if (disposed || !mountRef.current) return;
        const player = create(src, mountRef.current, {
          autoplay: reduced ? false : true,
          loop: reduced ? false : true,
          speed: reduced ? 1 : speed,
          idleTimeLimit: 2,
          terminalFontSize: "13px",
          theme: "asciinema",
          fit: "width",
          controls: reduced ? true : false,
        });
        playerRef.current = player as unknown as {
          pause?: () => void;
          dispose?: () => void;
        };
        if (reduced) playerRef.current?.pause?.();
      })
      .catch((err) => {
        // network/import failure: log so a blank player isn't silent.
        console.error("[AsciinemaPlayer] failed to load cast", src, err);
      });

    const onVisibility = () => {
      if (document.hidden) playerRef.current?.pause?.();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      // Release the player's playback resources so they don't survive after
      // React removes the container on navigation.
      playerRef.current?.dispose?.();
      playerRef.current = null;
    };
  }, [src, speed]);

  return (
    <div
      className="my-6 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--color-term-bg)] shadow-[0_0_24px_rgba(77,123,255,0.18)]"
      role="region"
      aria-label={title}
    >
      <div ref={mountRef} className="min-h-[12rem]" />
      <noscript>
        <p className="px-4 py-3 text-sm text-[var(--muted-foreground)]">
          The terminal replay needs JavaScript. The same commands are documented
          in the text above.
        </p>
      </noscript>
    </div>
  );
}
