/**
 * The DOM element types `@surface/editor/schema`'s TipTap parse rules name (PLAN-013 S3). The
 * server typechecks that entry's source, and those rules type their argument `HTMLElement`, so the
 * compiler needs the name; they never run here (the server parses no HTML). Only the members the
 * rules read are declared. The full DOM lib is not used: it would replace Node's global
 * `WebSocket` type and let DOM globals typecheck in server code.
 */
interface Element {
  getAttribute(name: string): string | null;
  readonly firstElementChild: Element | null;
  readonly className: string;
  readonly textContent: string | null;
}

// The rules name `HTMLElement`, which adds nothing they read, so it is `Element` by another name.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an alias the rules need
interface HTMLElement extends Element {}
