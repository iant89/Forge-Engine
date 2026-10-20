/**
 * Bounded command history for authoring operations.
 *
 * Commands are deliberately engine-agnostic closures. `EditorSession` validates entity/component
 * identity at each apply/revert boundary, while this class guarantees stack integrity when a
 * command throws: a failed undo or redo remains available instead of disappearing from history.
 */

import { EventTarget2, UsageError } from "@forge/engine";

export interface EditorCommand {
  readonly label: string;
  apply(): void;
  revert(): void;
}

export interface EditorHistoryOptions {
  /** Maximum retained undo entries. Defaults to 100. */
  limit?: number;
}

export interface EditorHistoryState {
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly nextUndoLabel: string | null;
  readonly nextRedoLabel: string | null;
}

/** Execute commands and retain a bounded, exception-safe undo/redo history. */
export class EditorHistory {
  readonly changed = new EventTarget2<EditorHistoryState>();

  private readonly limit: number;
  private readonly undoStack: EditorCommand[] = [];
  private readonly redoStack: EditorCommand[] = [];
  private busy = false;

  constructor(options: EditorHistoryOptions = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new UsageError(`EditorHistory.limit must be a positive safe integer, got ${limit}`);
    }
    this.limit = limit;
  }

  get state(): EditorHistoryState {
    return {
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      nextUndoLabel: this.undoStack.at(-1)?.label ?? null,
      nextRedoLabel: this.redoStack.at(-1)?.label ?? null,
    };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  execute(command: EditorCommand): void {
    const label = command.label.trim();
    if (!label) throw new UsageError("Editor commands require a non-empty label");
    const retained: EditorCommand = {
      label,
      apply: () => command.apply(),
      revert: () => command.revert(),
    };
    this.run(retained.apply);
    this.undoStack.push(retained);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit();
  }

  undo(): boolean {
    const command = this.undoStack.at(-1);
    if (!command) return false;
    this.run(command.revert);
    this.undoStack.pop();
    this.redoStack.push(command);
    this.emit();
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.at(-1);
    if (!command) return false;
    this.run(command.apply);
    this.redoStack.pop();
    this.undoStack.push(command);
    this.emit();
    return true;
  }

  clear(): void {
    if (this.undoStack.length === 0 && this.redoStack.length === 0) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  private run(action: () => void): void {
    if (this.busy) throw new UsageError("EditorHistory cannot execute a command recursively");
    this.busy = true;
    try {
      action();
    } finally {
      this.busy = false;
    }
  }

  private emit(): void {
    this.changed.emit(this.state);
  }
}
