# ADR-0004: Web application stack

Status: **Accepted (draft)** · Date: 2026-11-06

## Decision
- **React 19 + Vite** SPA, served by the server as static assets. No SSR is needed for an internal, authenticated app.
- **TanStack Router** for type-safe routes and URL-encoded filters.
- **TanStack Virtual** for lists and boards with 10k+ rows.
- **Radix UI primitives** for accessible popovers, menus, dialogs, and tooltips, styled by us.
- **CSS Modules + CSS custom-property design tokens.** Zero-runtime styling, and themes switch through variables.
- **cmdk-style command menu**, built on the Operation Registry metadata.
- Desktop wrapper (Tauri or Electron) and PWA install: later.

## Consequences
+ A small runtime, fast startup, and full control over the visual design.
− No component library to lean on. We build the design system ourselves (methodology Phase 4).
