// The React roots mounted in this worker, read through the DevTools hook React reports each commit
// to. `setup-react-roots.ts` installs it before anything loads `react-dom`: this module imports
// nothing. The tracker lives on `globalThis`, so every file of the worker reads the same roots.

interface FiberRoot {
  readonly containerInfo: unknown;
  readonly current: { readonly child: unknown };
}

interface RootTracker {
  readonly supportsFiber: true;
  readonly roots: Set<FiberRoot>;
  inject(): number;
  onCommitFiberRoot(rendererId: number, root: FiberRoot): void;
  onCommitFiberUnmount(): void;
}

declare global {
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: RootTracker | undefined;
}

function tracker(): RootTracker {
  const roots = new Set<FiberRoot>();
  return {
    supportsFiber: true,
    roots,
    inject: () => 1,
    // A root whose tree is empty was unmounted (or renders nothing): it holds no subscriptions.
    onCommitFiberRoot: (_rendererId, root) => {
      if (root.current.child === null) roots.delete(root);
      else roots.add(root);
    },
    onCommitFiberUnmount: () => undefined,
  };
}

/** Installs the tracker once per worker. */
export function trackReactRoots(): void {
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= tracker();
}

/**
 * Says which roots are still mounted, and forgets them, so the next file is told only about its
 * own; undefined when there are none.
 */
export function takeLeakedRoots(): string | undefined {
  const roots = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.roots;
  if (roots === undefined) return undefined;
  const leaked = [...roots].filter((root) => root.current.child !== null);
  roots.clear();
  if (leaked.length === 0) return undefined;
  const where = leaked
    .map((root) =>
      root.containerInfo instanceof Element
        ? `"${(root.containerInfo.textContent ?? '').slice(0, 80)}"`
        : 'a root',
    )
    .join(', ');
  return (
    `This file left ${leaked.length} React root(s) mounted (${where}). Unmount every root in ` +
    'afterEach (`root.unmount()` inside `act`): later files in the worker would see it.'
  );
}
