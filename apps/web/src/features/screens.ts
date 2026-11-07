// The PLAN-001 screens (SPEC-001 §7) the router renders, by route (app/screens.ts lists the ids).
// A feature keeps its screens in its own folder and adds one line here per screen; a route with
// no screen shows a placeholder. Shared registry file, append-only for every session (sessions
// README §7): add your own lines only, and on a rebase conflict keep both sides.
import type { ScreenRegistry } from '../app/screens.js';

export const SCREENS: ScreenRegistry = {};
