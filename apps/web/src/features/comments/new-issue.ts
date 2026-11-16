// "New issue from comment…" (SPEC-013 §3.3). It opens the composer with the comment's body as the
// description. The composer (PLAN-012 S5) has no description yet: `issue.create` takes none until
// PLAN-011 S6 (`composer-model.ts`), so opening it would drop the body. The entry stays hidden
// until then. When S6 lands: add a `comment` kind to `ComposerRequest`, let `IssuesHost` take it
// (fresh state with `description` set, title focused), call `openComposerWith` here, and make this
// return true.
export function composerAvailable(): boolean {
  return false;
}
