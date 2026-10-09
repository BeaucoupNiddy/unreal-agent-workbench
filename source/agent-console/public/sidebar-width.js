export const DEFAULT_SIDEBAR_WIDTH = 276;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 560;

// Reserve enough room for the conversation when resizing on a narrow desktop.
export function sidebarWidthLimit(viewportWidth) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - 320));
}

export function clampSidebarWidth(width, viewportWidth) {
  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, sidebarWidthLimit(viewportWidth))));
}
