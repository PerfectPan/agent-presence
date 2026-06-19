import { cn } from "~/lib/utils";

/**
 * Typography wrapper for documentation content. Applies markdown-like styles to
 * its children (headings, paragraphs, code, lists, tables).
 */
export function Prose({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-none space-y-4 leading-7",
        "[&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:mt-2",
        "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-2",
        "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-1",
        "[&_p]:text-[var(--foreground)]",
        "[&_a]:text-[var(--color-neon-blue)] [&_a]:underline [&_a]:underline-offset-2",
        "[&_strong]:font-semibold",
        "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6",
        "[&_li]:my-1",
        "[&_code]:rounded [&_code]:bg-[var(--muted)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:overflow-y-hidden",
        "[&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:bg-[var(--color-term-bg)] [&_pre]:p-4",
        "[&_pre_code]:block [&_pre_code]:w-max [&_pre_code]:min-w-full [&_pre_code]:whitespace-pre",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[var(--color-term-text)]",
        "[&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-sm",
        "[&_th]:border [&_th]:border-[var(--border)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border [&_td]:border-[var(--border)] [&_td]:px-3 [&_td]:py-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-neon-blue)] [&_blockquote]:pl-4 [&_blockquote]:text-[var(--muted-foreground)]",
        "[&_hr]:border-[var(--border)] [&_hr]:my-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
