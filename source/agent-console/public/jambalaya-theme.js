// Explicit app-owned leaf labels only: never translate user or model text, or
// replace a control's children (which would lose icons, keyboard hints, and listeners).
export function themeText(normal, jambalaya, enabled) { return enabled ? jambalaya : normal; }
export function applyJambalayaCopy(enabled) {
  document.querySelectorAll('[data-jambalaya][data-default]').forEach((el) => {
    if (el.children.length) return;
    el.textContent = enabled ? el.dataset.jambalaya : el.dataset.default;
  });
}
