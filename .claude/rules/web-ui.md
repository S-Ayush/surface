---
paths:
  - 'apps/web/**'
  - 'packages/ui/**'
  - 'packages/editor/**'
---

# Web app and design system

Specs: `docs/06-specs/SPEC-005-app-shell-command-menu-shortcuts.md`. Design: `docs/05-design/design-system.md`, `shortcuts.md`, `command-menu.md`.

- **Tokens only:** colours, spacing, radii, shadows and type come from semantic CSS variables. No hex, rgb or raw px values in component CSS (lint-enforced, except token files). Styles live in CSS Modules.
- **Every component meets the checklist** (design-system §5.4): light and dark themes, all states, full keyboard operation with a visible focus ring, an accessible name/role/state (axe), a story with a visual snapshot, and fast rendering (nothing measured during render).
- **Keyboard-first:**
  - Every user action is reachable from the keyboard and appears in the command menu (`Mod+K`) when it applies.
  - Shortcuts are registered through the shortcut registry, never with ad-hoc `keydown` listeners. Check `docs/05-design/shortcuts.md` for conflicts.
- **Data flow:** UI reads from the sync-client store (MobX observables) and changes data only via `dispatch(operation, input)`. No direct `fetch` for domain data, and no server state copied into component state.
- **Self-contained:** no external fonts, CDNs, analytics or remote images. Fonts and icons (Lucide) are bundled.
- **Copy:** use sentence case and verbs on buttons ("Create issue"). Errors say what to do. Platform-aware key labels come from `<Kbd>`.
- **React:** function components and hooks only. Keep components small, and lift logic into stores or hooks. Respect `eslint-plugin-react-hooks`.
