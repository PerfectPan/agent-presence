/**
 * Site navigation + i18n config.
 *
 * English is the authoritative tree (root paths). Simplified Chinese mirrors it
 * under /zh/. Both trees share the same slugs so the sidebar renders identically
 * in either locale.
 *
 * Content is derived from the repository README files, docs/architecture.md,
 * rfcs/, CONTRIBUTING.md, SECURITY.md, and CHANGELOG.md. English README is the
 * single source of truth for behavior.
 */

export interface NavItem {
  slug: string; // path segment(s) without locale prefix, e.g. "guides/install"
  label: { en: string; zh: string };
}

export interface NavSection {
  id: string;
  label: { en: string; zh: string };
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "guides",
    label: { en: "Guides", zh: "指南" },
    items: [
      { slug: "guides/install", label: { en: "Installation", zh: "安装" } },
      { slug: "guides/quickstart", label: { en: "Quickstart", zh: "快速上手" } },
      { slug: "guides/providers", label: { en: "Providers", zh: "Provider" } },
      {
        slug: "guides/token-usage",
        label: { en: "Token usage", zh: "Token 用量" },
      },
      {
        slug: "guides/presence-semantics",
        label: { en: "Presence semantics", zh: "Presence 语义" },
      },
      {
        slug: "guides/render-templates",
        label: { en: "Render templates", zh: "渲染模板" },
      },
      { slug: "guides/uninstall", label: { en: "Uninstall", zh: "卸载" } },
    ],
  },
  {
    id: "reference",
    label: { en: "Reference", zh: "参考" },
    items: [
      { slug: "reference/commands", label: { en: "Commands", zh: "命令" } },
      {
        slug: "reference/configuration",
        label: { en: "Configuration",
          zh: "配置" },
      },
      {
        slug: "reference/environment-variables",
        label: { en: "Environment variables", zh: "环境变量" },
      },
    ],
  },
  {
    id: "project",
    label: { en: "Project", zh: "项目" },
    items: [
      {
        slug: "project/architecture",
        label: { en: "Architecture", zh: "架构" },
      },
      {
        slug: "project/contributing",
        label: { en: "Contributing", zh: "贡献" },
      },
      { slug: "project/security", label: { en: "Security", zh: "安全" } },
      { slug: "project/rfcs", label: { en: "RFCs", zh: "RFC" } },
      { slug: "project/changelog", label: { en: "Changelog", zh: "更新日志" } },
    ],
  },
];

export type Locale = "en" | "zh";

export interface LocaleMeta {
  code: Locale;
  label: string;
  prefix: string; // "" for en, "zh" for zh
  htmlLang: string;
}

export const LOCALES: LocaleMeta[] = [
  { code: "en", label: "English", prefix: "", htmlLang: "en" },
  { code: "zh", label: "简体中文", prefix: "zh", htmlLang: "zh-CN" },
];

/** Build the href for a slug in a given locale. */
export function hrefFor(locale: Locale, slug: string): string {
  const meta = LOCALES.find((l) => l.code === locale)!;
  if (slug === "") {
    return meta.prefix ? `/${meta.prefix}` : "/";
  }
  return meta.prefix ? `/${meta.prefix}/${slug}` : `/${slug}`;
}

/** The counterpart URL of the current page in the other locale. */
export function switchLocaleHref(
  currentPath: string,
  target: Locale,
): string {
  const targetMeta = LOCALES.find((l) => l.code === target)!;
  // strip existing locale prefix (either "" or "zh")
  let rest = currentPath;
  if (rest.startsWith("/zh")) rest = rest.slice(3);
  if (!rest.startsWith("/")) rest = "/" + rest;
  if (rest === "/") rest = "";
  return targetMeta.prefix ? `/${targetMeta.prefix}${rest}` : `${rest || "/"}`;
}
