# Design notes — agent-presence site

Rationale behind the docs site + landing page, so future changes stay coherent.

## Concept

agent-presence is a terminal tool that shows a **live count of working AI agents**
and their **token spend** in a Feishu signature. The site is framed as a *live
presence monitor*: the hero is the product itself, animating.

**Deliberately avoided** the two clichés AI design tends to default to:

- near-black background + a single acid-green accent (the generic "terminal tool"
  look), and
- warm-cream + serif + terracotta.

Instead: a **light, airy canvas** with a **dark terminal floating in the hero** as
the high-contrast centerpiece. The terminal is dark because terminals *are* dark —
on a light page it reads as intentional, not as a theme default.

## Signature element

The hero terminal is the one thing the page is built around. It replays a real
`agent-presence` session — types `npm i -g …` → `setup`, ticks the agent count
1→2→3, accrues token cost — and resolves into the **actual Feishu signature badge**
(`3 个 AI 牛马正在并行搬砖 | claude 2 · codex 1 | 今日 …`). It is the product in one
animated moment. Pure CSS/JS, no deps (`components/LiveTerminal.astro`).

## Tokens

Defined once in `src/styles/global.css` (`--ap-*`), and mapped onto Starlight's
`--sl-*` variables so docs and landing share one system.

| Token | Value | Use |
| --- | --- | --- |
| `--ap-blue` | `#2563eb` | primary accent |
| `--ap-sky` | `#38bdf8` | gradient end |
| `--ap-grad` | blue→sky | headline, buttons, accents |
| `--ap-emerald` | `#10b981` | the "live" dot only |
| `--ap-ink` (`--ap-text`) | `#15171f` | text |
| `--ap-bg` | `#f7f8fb` | canvas |

The accent is **blue→sky** — not purple, not neon green (both were tried and
rejected during review). Emerald is reserved for the live/online dot.

## Type

- **Space Grotesk** — display (techy character, used for headings + numbers)
- **Inter** — body
- **JetBrains Mono** — the terminal and all code/labels

## Motion

One orchestrated hero loop, nothing scattered. It **pauses when off-screen**
(`IntersectionObserver`) and renders a single settled frame under
`prefers-reduced-motion`. Section/card hovers are restrained.

## Brand mark

`src/assets/brand-icon.svg` (and `public/favicon.svg`): a blue→sky gradient tile
with a white terminal prompt `>_` and a green live dot — terminal + presence +
live. Documented for users at `/project/brand`.

## Architecture

- **Docs** are [Starlight](https://starlight.astro.build). Content in
  `src/content/docs/` (English at root, 简体中文 under `zh/`).
- **Landing** is one data-driven layout, `src/layouts/Landing.astro`. The two
  entry pages (`src/pages/index.astro`, `src/pages/zh/index.astro`) are ~50 lines
  of locale strings each — all markup and CSS live in the layout, so the EN/ZH
  pages can't drift.
- **i18n**: Starlight's built-in locales; sidebar labels carry `translations`.
- **Theme + language pickers** are custom components (`ThemeSelect.astro`,
  `LanguageSelect.astro`) that replace Starlight's native `<select>` — the native
  dropdown renders an un-stylable OS menu. The light theme is the default (a head
  script seeds `localStorage`), and the same `EN · 中` pill is reused on the
  landing nav so the switch is identical inside and outside the docs.
- **Code blocks**: Expressive Code with `frame: 'code'` (no terminal-window
  chrome) and a tokened panel background.

## `dev-grab` (local only)

`public/dev-grab.js` is a dev-only element grabber: Alt-click any element to copy
its selector + computed styles to the clipboard for design fine-tuning. It only
activates on `localhost` and is injected only in `astro dev`.

## Develop & deploy

```bash
pnpm install
pnpm docs:dev       # local
pnpm docs:build     # static output in dist/
```

Deploy on **Vercel** with the project root set to `site/` (framework: Astro,
build: `astro build`, output: `dist`). `vercel.json` is included.
