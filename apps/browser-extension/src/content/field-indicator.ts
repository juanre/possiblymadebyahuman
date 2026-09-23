// Field status lives outside the editor so it cannot become document content.
// Track geometry while indicators exist: resize/scroll observers alone miss
// editors moved by ancestor transforms or layout (for example Gmail compose).
type Indicator = { status: HTMLDivElement; button: HTMLButtonElement; intersecting: boolean };
const indicators = new Map<HTMLElement, Indicator>();
let frame: number | null = null;
let visibility: IntersectionObserver | null = null;

function trackPositions(): void {
  frame = null;
  // Read geometry before writing styles; unchanged positions cause no writes.
  const positions = [];
  for (const [field, indicator] of indicators) {
    if (!field.isConnected) {
      indicator.status.remove();
      visibility?.unobserve(field);
      indicators.delete(field);
      continue;
    }
    const rect = field.getBoundingClientRect();
    const shown = indicator.intersecting && rect.width > 0 && rect.height > 0
      && field.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
      && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    positions.push({ indicator, shown, top: Math.max(4, rect.top + 4),
      right: Math.max(4, innerWidth - rect.right + 4) });
  }
  for (const { indicator, shown, top, right } of positions) {
    const style = indicator.status.style;
    const display = shown ? "block" : "none";
    if (style.display !== display) style.display = display;
    if (style.top !== `${top}px`) style.top = `${top}px`;
    if (style.right !== `${right}px`) style.right = `${right}px`;
  }
  if (indicators.size) frame = requestAnimationFrame(trackPositions);
  else { visibility?.disconnect(); visibility = null; }
}

export function setFieldIndicator(
  field: HTMLElement, label: string, color: string, openControls: () => Promise<boolean>,
): void {
  let indicator = indicators.get(field);
  if (!indicator) {
    visibility ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const indicator = indicators.get(entry.target as HTMLElement);
        if (indicator) indicator.intersecting = entry.isIntersecting;
      }
    });
    const status = document.createElement("div");
    status.contentEditable = "false";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("data-pmbah-indicator", "");
    status.style.cssText = "all:initial;position:fixed;z-index:2147483647;max-width:calc(100vw - 8px);display:none";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Open PMBAH writing records";
    button.style.cssText = [
      "all:initial", "display:block", "box-sizing:border-box", "max-width:100%",
      "padding:3px 8px", "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
      "color:#fbf8f2", "border:1px solid #ffffff66", "border-radius:12px", "cursor:pointer",
    ].join(";");
    // Keep the editor's selection intact when opening the signing controls.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("focus", () => { button.style.outline = "2px solid #2f80ed"; });
    button.addEventListener("blur", () => { button.style.outline = "none"; });
    button.addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      event.stopPropagation();
      const opened = await openControls().catch(() => false);
      if (!opened) {
        button.textContent = "Open PMBAH from Chrome’s extensions menu";
        button.setAttribute("aria-label", button.textContent);
      }
    });
    status.append(button);
    document.body.append(status);
    indicator = { status, button, intersecting: false };
    indicators.set(field, indicator);
    visibility.observe(field);
  }
  indicator.button.textContent = `PMBAH · ${label} ↗`;
  indicator.button.setAttribute("aria-label", `PMBAH: ${label}. Open writing records`);
  indicator.button.style.background = color;
  if (frame === null) frame = requestAnimationFrame(trackPositions);
}
