import type { Config } from "@react-router/dev/config";

// SSG-friendly: pre-render everything. The docs site is fully static content,
// so we render all routes at build time (no runtime server needed in practice;
// react-router-serve still works for local preview).
export default {
  ssr: true,
  prerender: true,
} satisfies Config;
