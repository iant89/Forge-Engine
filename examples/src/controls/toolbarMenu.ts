/**
 * Collapse the demo's top-right DEMO SCENE / TONE MAPPING / RENDERING panels behind a hamburger.
 *
 * The panels stay in the DOM (the browser gate and `__forge` toggles still reach every button); only
 * visibility changes. Closed by default so a phone-sized Mars Showcase is not buried under three
 * stacked panels. Tap the button to open; tap again or outside the toolbar to collapse.
 */

export interface ToolbarMenuHandle {
  /** True when the panels are shown. */
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  dispose(): void;
}

export function attachToolbarMenu(options: {
  toolbar: HTMLElement | null;
  toggle: HTMLElement | null;
  /** Override for unit tests (Node has no `document`). Defaults to the page document when present. */
  rootDocument?: Pick<Document, "addEventListener" | "removeEventListener"> | null;
}): ToolbarMenuHandle {
  const { toolbar, toggle } = options;
  const doc =
    options.rootDocument ??
    (typeof document !== "undefined" ? document : null);
  let open = false;

  const sync = (): void => {
    toolbar?.classList.toggle("toolbar-open", open);
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");
    toggle?.classList.toggle("active", open);
  };

  const setOpen = (next: boolean): void => {
    open = next;
    sync();
  };

  const onToggle = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(!open);
  };

  const onDocPointer = (event: Event): void => {
    if (!open || !toolbar) return;
    const target = event.target as Node | null;
    if (target && toolbar.contains(target)) return;
    setOpen(false);
  };

  toggle?.addEventListener("click", onToggle);
  // pointerdown so a drag that starts outside still collapses; click alone misses that case on touch.
  doc?.addEventListener("pointerdown", onDocPointer);

  sync();

  return {
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    dispose(): void {
      toggle?.removeEventListener("click", onToggle);
      doc?.removeEventListener("pointerdown", onDocPointer);
      open = false;
      sync();
    },
  };
}
