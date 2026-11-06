// The overlay manager (PLAN-005 S3, SPEC-005 §6 "Toasts, banners, modal stack: overlay manager,
// memory"). One instance per app holds the stack of open overlay layers, the toast queue and the
// banner queue. React reads it with useSyncExternalStore; anything else (the sync engine, the
// shortcut engine) calls it directly: `toast(...)`, `banner.show(id, ...)`, `overlayManager.topLayer()`.

/**
 * What an open layer is. The shortcut engine (S5) maps `modal` to the modal scope and `popover` /
 * `menu` to the picker scope, so the top-most layer's bindings win (shortcuts.md §1.4).
 */
export type LayerKind = 'modal' | 'popover' | 'menu';
export type OverlayLayer = { readonly id: string; readonly kind: LayerKind };

/** design-system §5.1: 5 s, or 8 s when the toast has an action (time to reach "Undo"). */
export const TOAST_DURATION_MS = 5000;
export const TOAST_ACTION_DURATION_MS = 8000;
/**
 * design-system §5.1: at most three toasts are stacked; later ones wait their turn. A toast raised
 * while an overlay is open also waits until it closes: Radix sends `Esc` only to the newest layer,
 * and a toast mounted above a dialog would swallow the `Esc` meant for the dialog.
 */
export const MAX_VISIBLE_TOASTS = 3;

export type ToastTone = 'neutral' | 'success' | 'danger';
export type ToastAction = {
  label: string;
  onAction: () => void;
  /** How to do the same without the toast, for screen readers (Radix `altText`). Defaults to the label. */
  altText?: string;
};
export type ToastOptions = {
  message: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Reusing an id replaces that toast in place instead of stacking a duplicate. */
  id?: string;
  /** Milliseconds; `Infinity` keeps it until dismissed. Defaults per design-system §5.1. */
  duration?: number;
};
export type Toast = {
  readonly id: string;
  /** Changes when the toast is updated in place, so it remounts: announced again, timer restarted. */
  readonly revision: number;
  readonly message: string;
  readonly tone: ToastTone;
  readonly action: ToastAction | undefined;
  readonly duration: number;
};

export type BannerTone = 'info' | 'warning' | 'danger';
export type BannerAction = { label: string; onAction: () => void };

/**
 * Which banner wins when several apply (one is shown at a time). Defaults follow the tone; a
 * condition that blocks syncing until the user acts (outdated client, SPEC-005 §8) passes
 * `blocking`, so a dismissible warning can never hide it.
 */
export const BANNER_PRIORITY = { info: 1, warning: 2, danger: 3, blocking: 4 } as const;
export type BannerOptions = {
  message: string;
  tone: BannerTone;
  action?: BannerAction;
  /** Persistent banners (offline, outdated client) have no dismiss button (SPEC-005 §8). */
  dismissible?: boolean;
  /** Higher wins; defaults to the tone's (BANNER_PRIORITY). */
  priority?: number;
};
export type Banner = {
  readonly id: string;
  readonly message: string;
  readonly tone: BannerTone;
  readonly action: BannerAction | undefined;
  readonly dismissible: boolean;
  readonly priority: number;
};

export type OverlaySnapshot = {
  /** Open layers, bottom first. */
  readonly layers: readonly OverlayLayer[];
  /** Toasts on screen, oldest first. */
  readonly visibleToasts: readonly Toast[];
  /** Toasts waiting for a free slot, oldest first. */
  readonly queuedToasts: readonly Toast[];
  /** The banner on screen: the highest priority, then the oldest. The rest wait behind it. */
  readonly banner: Banner | undefined;
  readonly banners: readonly Banner[];
};

export class OverlayManager {
  #layers: readonly OverlayLayer[] = [];
  #toasts: readonly Toast[] = [];
  /** Toasts that have been on screen; they stay there while an overlay opens over them. */
  #shown = new Set<string>();
  /** Insertion order is kept, so equal severities show oldest first. */
  #banners = new Map<string, Banner>();
  #snapshot: OverlaySnapshot = {
    layers: [],
    visibleToasts: [],
    queuedToasts: [],
    banner: undefined,
    banners: [],
  };
  #listeners = new Set<() => void>();
  #seq = 0;
  /** Esc key events that arrived while an overlay was open (see isOverlayEscape). */
  #overlayEscapes = new WeakSet<object>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): OverlaySnapshot => this.#snapshot;

  /** The top-most open layer, which receives `Esc` and navigation keys first. */
  topLayer(): OverlayLayer | undefined {
    return this.#layers.at(-1);
  }

  /**
   * Records whether a keydown is an `Esc` for an open overlay. <OverlayProvider> calls it from a
   * window capture-phase listener, which runs before Radix's document listener closes the overlay.
   */
  noteKeydown(event: { readonly key: string }): void {
    if (event.key === 'Escape' && this.#layers.length > 0) this.#overlayEscapes.add(event);
  }

  /**
   * Whether this `Esc` belongs to an overlay, which closes on it. The shortcut engine (S5) runs
   * page-level `Esc` (clear selection) only when this is false. Neither `topLayer()` nor
   * `defaultPrevented` can answer it: by the time a document listener runs, the overlay may
   * already have closed and unregistered.
   */
  isOverlayEscape(event: object): boolean {
    return this.#overlayEscapes.has(event);
  }

  pushLayer(kind: LayerKind): string {
    const id = `layer-${++this.#seq}`;
    this.#layers = [...this.#layers, { id, kind }];
    this.#emit();
    return id;
  }

  /** Removes a layer wherever it is: a parent can close before its child unmounts. */
  removeLayer(id: string): void {
    if (!this.#layers.some((layer) => layer.id === id)) return;
    this.#layers = this.#layers.filter((layer) => layer.id !== id);
    this.#emit();
  }

  toast(options: ToastOptions | string): string {
    const opts = typeof options === 'string' ? { message: options } : options;
    // A generated id skips any id a caller chose.
    let id = opts.id;
    while (id === undefined || (opts.id === undefined && this.#toasts.some((t) => t.id === id))) {
      id = `toast-${++this.#seq}`;
    }
    const next: Toast = {
      id,
      revision: ++this.#seq,
      message: opts.message,
      tone: opts.tone ?? 'neutral',
      action: opts.action,
      duration:
        opts.duration ?? (opts.action === undefined ? TOAST_DURATION_MS : TOAST_ACTION_DURATION_MS),
    };
    const index = this.#toasts.findIndex((t) => t.id === id);
    this.#toasts =
      index === -1 ? [...this.#toasts, next] : this.#toasts.map((t, i) => (i === index ? next : t));
    this.#emit();
    return id;
  }

  dismissToast(id: string): void {
    if (!this.#toasts.some((t) => t.id === id)) return;
    this.#toasts = this.#toasts.filter((t) => t.id !== id);
    this.#shown.delete(id);
    this.#emit();
  }

  /** Shows a banner, or updates it in place when `id` is already shown or queued. */
  showBanner(id: string, options: BannerOptions): void {
    this.#banners.set(id, {
      id,
      message: options.message,
      tone: options.tone,
      action: options.action,
      dismissible: options.dismissible ?? false,
      priority: options.priority ?? BANNER_PRIORITY[options.tone],
    });
    this.#emit();
  }

  hideBanner(id: string): void {
    if (this.#banners.delete(id)) this.#emit();
  }

  /** Removes every toast and banner. Layers belong to mounted overlays and stay. */
  clear(): void {
    this.#toasts = [];
    this.#shown.clear();
    this.#banners.clear();
    this.#emit();
  }

  #emit(): void {
    // Stable sort: equal priorities keep insertion order, so the oldest shows first.
    const banners = [...this.#banners.values()].sort((a, b) => b.priority - a.priority);
    // Oldest first: a waiting toast keeps every later one waiting too.
    const overlayOpen = this.#layers.length > 0;
    let visible = 0;
    for (const t of this.#toasts.slice(0, MAX_VISIBLE_TOASTS)) {
      if (overlayOpen && !this.#shown.has(t.id)) break;
      this.#shown.add(t.id);
      visible++;
    }
    this.#snapshot = {
      layers: this.#layers,
      visibleToasts: this.#toasts.slice(0, visible),
      queuedToasts: this.#toasts.slice(visible),
      banner: banners[0],
      banners,
    };
    for (const listener of this.#listeners) listener();
  }
}

/** The app's overlay manager. `<OverlayProvider>` renders its toasts; `<BannerRegion>` its banners. */
export const overlayManager = new OverlayManager();

/** Shows a toast and returns its id. `toast.dismiss(id)` removes it early. */
export const toast = Object.assign(
  (options: ToastOptions | string): string => overlayManager.toast(options),
  { dismiss: (id: string): void => overlayManager.dismissToast(id) },
);

/** System banners (SPEC-005 §8), keyed by condition, e.g. `banner.show('offline', {...})`. */
export const banner = {
  show: (id: string, options: BannerOptions): void => overlayManager.showBanner(id, options),
  hide: (id: string): void => overlayManager.hideBanner(id),
};
