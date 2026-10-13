/**
 * Clipboard copy that works on iOS Safari. Call it synchronously from the tap/click handler:
 * WebKit only grants clipboard access inside the user gesture, so `navigator.clipboard.writeText`
 * is started before any await. When it is missing or rejects, fall back to a hidden read-only
 * textarea + `setSelectionRange` + `document.execCommand("copy")` (the pre-Async-Clipboard path iOS
 * still honours, and which needs an explicit selection range rather than `select()`).
 */
export interface CopyEnv {
  clipboard?: { writeText(text: string): Promise<void> } | null;
  document: Pick<Document, "createElement" | "execCommand"> & { body: Pick<HTMLElement, "appendChild" | "removeChild"> };
}

export function fallbackCopy(text: string, env: CopyEnv): boolean {
  const doc = env.document;
  const area = doc.createElement("textarea");
  area.value = text;
  // readOnly keeps the iOS keyboard down; contentEditable lets WebKit treat the range as selectable.
  area.readOnly = true;
  area.contentEditable = "true";
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;";
  doc.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

export function copyText(text: string, env: CopyEnv): Promise<boolean> {
  const clip = env.clipboard;
  if (clip && typeof clip.writeText === "function") {
    let pending: Promise<void>;
    try {
      pending = clip.writeText(text); // synchronous call, still inside the gesture
    } catch {
      return Promise.resolve(fallbackCopy(text, env));
    }
    return pending.then(
      () => true,
      () => fallbackCopy(text, env),
    );
  }
  return Promise.resolve(fallbackCopy(text, env));
}
