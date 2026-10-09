// Browsers do not expose an iOS keyboard-open event. Detect its viewport
// reduction instead, so focus alone (e.g. a hardware keyboard) is not enough.
export function setupKeyboardDismissal(prompt, button, win = window, doc = document) {
  const viewport = win.visualViewport;
  const layoutHeight = () => Math.max(win.innerHeight, doc.documentElement.clientHeight);
  let baselineHeight = layoutHeight();
  let baselineWidth = win.innerWidth;

  function update() {
    const focused = doc.activeElement === prompt;
    const visibleHeight = viewport?.height ?? win.innerHeight;
    if (!focused || win.innerWidth !== baselineWidth) {
      baselineHeight = Math.max(layoutHeight(), visibleHeight);
      baselineWidth = win.innerWidth;
    }
    const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.05;
    const keyboardOpen = focused && !zoomed && Math.max(baselineHeight, layoutHeight()) - visibleHeight >= 100;
    button.hidden = !keyboardOpen;
    // The keyboard covers the home-indicator area; do not reserve it twice.
    doc.documentElement.dataset.keyboardOpen = String(keyboardOpen);
  }

  // Keep the prompt focused until click. Otherwise tapping the icon can blur
  // the input and hide the button before its click is delivered on iOS.
  button.addEventListener("pointerdown", (event) => {
    if (event.button === 0) event.preventDefault();
  });
  button.addEventListener("click", () => {
    prompt.blur();
    update();
  });
  prompt.addEventListener("focus", update);
  prompt.addEventListener("blur", update);
  win.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  update();
}
