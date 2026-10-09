// Keeps the conversation pinned to the newest output only while the reader is
// at the bottom. Scrolling up stops following until they return to the bottom
// or choose "Latest"; re-renders then keep their place.
export const followThreshold = 80;

export function nearBottom(element, threshold = followThreshold) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function createScrollFollow(element, { onChange = () => {}, nextFrame = (callback) => requestAnimationFrame(callback) } = {}) {
  let following = true;
  const set = (value) => { if (value !== following) { following = value; onChange(following); } };
  element.addEventListener("scroll", () => set(nearBottom(element)), { passive: true });
  const toBottom = () => { element.scrollTop = element.scrollHeight; };
  return {
    get following() { return following; },
    // Returns to the newest output and keeps following it.
    follow() { set(true); toBottom(); nextFrame(() => { if (following) toBottom(); }); },
    // Call before replacing the transcript, then pass the result to afterRender.
    beforeRender() { return element.scrollTop; },
    afterRender(savedTop) {
      if (!following) { element.scrollTop = savedTop; return; }
      toBottom();
      nextFrame(() => { if (following) toBottom(); });
    }
  };
}
