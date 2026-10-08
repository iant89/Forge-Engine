import type { RoverToolAction } from "../scenes/roverTools.js";

export interface RoverToolTouchHandle {
  readonly visible: boolean;
  setTarget(label: string | null): void;
  setBusy(status: string | null): void;
  setProgress(progress: number): void;
  dispose(): void;
}

/** Connect the proximity-triggered rover tool panel to scene actions. */
export function attachRoverToolTouch(
  root: HTMLElement | null,
  onAction: (action: RoverToolAction) => void,
): RoverToolTouchHandle {
  const panel = root?.querySelector<HTMLElement>("#rover-tool-panel") ?? null;
  const targetLabel = root?.querySelector<HTMLElement>("#rover-tool-target") ?? null;
  const status = root?.querySelector<HTMLElement>("#rover-tool-status") ?? null;
  const progress = root?.querySelector<HTMLElement>("#rover-tool-progress") ?? null;
  const buttons = new Map<RoverToolAction, HTMLButtonElement>();
  for (const action of ["drill", "abrade", "analyze"] as const) {
    const button = root?.querySelector<HTMLButtonElement>(`#mars-tool-${action}`) ?? null;
    if (button) buttons.set(action, button);
  }

  let target: string | null = null;
  let busyStatus: string | null = null;
  const listeners: Array<[HTMLElement, string, EventListener]> = [];

  for (const [action, button] of buttons) {
    const listener = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled && target && !busyStatus) onAction(action);
    };
    button.addEventListener("click", listener);
    listeners.push([button, "click", listener]);
  }

  const sync = (): void => {
    const shown = !!target || !!busyStatus;
    panel?.classList.toggle("shown", shown);
    panel?.setAttribute("aria-hidden", shown ? "false" : "true");
    targetLabel && (targetLabel.textContent = target ?? "ROVER TOOL OPERATION");
    status && (status.textContent = busyStatus ?? "Select a turret tool");
    for (const button of buttons.values()) button.disabled = !target || !!busyStatus;
  };

  sync();

  return {
    get visible(): boolean {
      return !!target || !!busyStatus;
    },
    setTarget(label: string | null): void {
      target = label;
      if (!busyStatus) sync();
    },
    setBusy(value: string | null): void {
      busyStatus = value;
      sync();
    },
    setProgress(value: number): void {
      const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
      if (progress) {
        progress.style.width = `${percent}%`;
        progress.setAttribute("aria-valuenow", String(percent));
      }
    },
    dispose(): void {
      for (const [element, type, listener] of listeners) element.removeEventListener(type, listener);
      panel?.classList.remove("shown");
      panel?.setAttribute("aria-hidden", "true");
    },
  };
}
