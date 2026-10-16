/**
 * `UIContainer` — an element whose children are public API.
 *
 * Leaf widgets compose internal parts through the protected `insertChild`; containers expose
 * `add`/`insert`/`remove`/`clear`. The container's layout strategy (`layout`) decides how children are
 * measured and arranged; a container without one stacks children over its content box.
 *
 * Containers default to `pointerEvents: "children"`: an empty part of a full-screen layout container
 * does not swallow clicks meant for the 3D view or a lower layer. Containers that paint a background
 * (`Panel`) switch that back to `"auto"`.
 */

import type { UIElement, UIElementOptions } from "./element.js";
import { UIElement as Base } from "./element.js";
import type { LayoutStrategy } from "../layout/types.js";

export interface UIContainerOptions extends UIElementOptions {
  layout?: UIElementOptions["layout"];
  strategy?: LayoutStrategy | null;
  children?: readonly UIElement[];
  clipChildren?: boolean;
}

export class UIContainer extends Base {
  static override styleName = "Container";

  constructor(options: UIContainerOptions = {}) {
    super(options);
    this.pointerEvents = "children";
    if (options.strategy) this.layout = options.strategy;
    if (options.clipChildren) this.clipChildren = true;
    if (options.children) for (const c of options.children) this.add(c);
  }

  /** Append a child (moves it from its current parent). Returns the child. */
  add<T extends UIElement>(child: T): T {
    this.insertChild(child);
    return child;
  }

  /** Append several children. */
  addAll(...children: UIElement[]): this {
    for (const c of children) this.insertChild(c);
    return this;
  }

  insert<T extends UIElement>(child: T, index: number): T {
    this.insertChild(child, index);
    return child;
  }

  /** Detach a child without disposing it. */
  remove(child: UIElement): boolean {
    return this.removeChild(child);
  }

  /** Dispose every child. */
  clear(): void {
    while (this.children.length > 0) this.children[this.children.length - 1]!.dispose();
  }
}
