// Browser side panel: shows what the agents' built-in browser is doing in the
// selected chat — the latest page frame from each agent, and every step with
// its result. The bridge records this locally; nothing here reaches the model.
const POLL_OPEN_MS = 1500;
const POLL_RUNNING_MS = 4000;
const MAX_STEPS = 300;
const ACTION_LABELS = {
  open: "Open", snapshot: "Read page", click: "Click", type: "Type", press: "Press", select: "Select", hover: "Hover",
  wait: "Wait", scroll: "Scroll", back: "Back", forward: "Forward", reload: "Reload", screenshot: "Screenshot",
  console: "Console", network: "Network", eval: "Run script", tabs: "Tabs", viewport: "Viewport"
};

export function stepLabel(entry) { return ACTION_LABELS[entry?.action] || String(entry?.action || "Step"); }

// Short result chips for one step, most important first.
export function stepBadges(entry) {
  const badges = [];
  if (entry?.ok === false) badges.push({ kind: "error", text: "Failed" });
  if (entry?.status) badges.push({ kind: entry.status >= 400 ? "error" : "ok", text: `HTTP ${entry.status}` });
  if (entry?.errors) badges.push({ kind: "warn", text: `${entry.errors} console error${entry.errors === 1 ? "" : "s"}` });
  if (entry?.failures) badges.push({ kind: "warn", text: `${entry.failures} failed request${entry.failures === 1 ? "" : "s"}` });
  if (entry?.screenshot) badges.push({ kind: "shot", text: "Screenshot" });
  return badges;
}

// Adds newly fetched steps; a trimmed log on the bridge replaces the list.
export function mergeSteps(steps, response) {
  const incoming = Array.isArray(response?.entries) ? response.entries : [];
  const merged = response?.reset ? incoming : [...steps, ...incoming.filter((entry) => !steps.some((step) => step.seq === entry.seq))];
  return merged.slice(-MAX_STEPS);
}

export function imageUrl(sessionId, name, version = "") {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/image/${encodeURIComponent(name)}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

export function clockTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

// Opens by itself once per chat when a running task starts browsing, unless
// the reader already closed it for that chat or is on a narrow screen.
export function shouldAutoOpen({ open, running, newSteps, dismissed, narrow }) {
  return !open && running && newSteps > 0 && !dismissed && !narrow;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function signInStatusText(status) {
  if (status?.error) return { text: status.error, error: true };
  if (status?.open) return { text: "A sign-in window is open on this Mac. Sign in, then close the window to save.", error: false };
  return { text: "", error: false };
}

// "Signed-in sites": the user signs in once in a visible window on the Mac;
// the console saves that session for the agents' browsers.
function setupSignIns(panel) {
  const section = panel.querySelector(".browser-signins");
  const count = section.querySelector(".browser-signin-count");
  const list = section.querySelector(".browser-signin-list");
  const form = section.querySelector(".browser-signin-form");
  const input = section.querySelector(".browser-signin-url");
  const submit = form.querySelector("button");
  const status = section.querySelector(".browser-signin-status");
  let timer = null;

  function render(data) {
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    count.textContent = sites.length ? `(${sites.length})` : "";
    list.replaceChildren(...sites.map((site) => {
      const item = element("li");
      const forget = element("button", "", "Forget");
      forget.type = "button";
      forget.title = `Sign the agents' browser out of ${site}`;
      forget.addEventListener("click", () => void request("DELETE", `?site=${encodeURIComponent(site)}`));
      item.append(element("span", "", site), forget);
      return item;
    }));
    if (!input.value && data?.suggestedUrl) input.value = data.suggestedUrl;
    const message = signInStatusText(data);
    status.textContent = message.text;
    status.classList.toggle("error", message.error);
    submit.disabled = Boolean(data?.open);
    clearTimeout(timer);
    if (data?.open) timer = setTimeout(() => void request("GET"), 2000);
  }

  async function request(method, query = "", body) {
    try {
      const response = await fetch(`/api/browser/sign-ins${query}`, { method, cache: "no-store",
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      render(data);
    } catch (error) {
      status.textContent = error.message || "Signed-in sites are unavailable.";
      status.classList.add("error");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (url) void request("POST", "", { url });
  });
  return { refresh: () => request("GET") };
}

export function setupBrowserPanel({ button, panel, getSessionId, isRunning, onOpen }) {
  const signIns = setupSignIns(panel);
  const frame = panel.querySelector(".browser-frame");
  const image = panel.querySelector(".browser-frame img");
  const placeholder = panel.querySelector(".browser-frame-empty");
  const address = panel.querySelector(".browser-address");
  const pageTitle = panel.querySelector(".browser-page-title");
  const viewing = panel.querySelector(".browser-viewing");
  const backToLive = panel.querySelector(".browser-live");
  const agentSelect = panel.querySelector(".browser-agent");
  const list = panel.querySelector(".browser-steps");
  const empty = panel.querySelector(".browser-empty");
  const closeButton = panel.querySelector(".browser-close");
  const dot = button.querySelector(".browser-dot");
  let sessionId = null, steps = [], agents = [], total = 0, selectedAgent = "", pinnedShot = null;
  let timer = null, inFlight = false, unseen = false, loaded = false;
  const dismissed = new Set();
  const isOpen = () => !panel.hidden;

  function reset() {
    steps = []; agents = []; total = 0; selectedAgent = ""; pinnedShot = null; unseen = false; loaded = false;
  }

  function currentAgent() {
    return agents.find((agent) => agent.key === selectedAgent) || agents.find((agent) => agent.key === steps.at(-1)?.agentKey) || agents[0];
  }

  function renderFrame() {
    const agent = currentAgent();
    const shot = pinnedShot;
    const name = shot?.screenshot || agent?.frame;
    image.hidden = !name;
    placeholder.hidden = Boolean(name);
    if (name) {
      const src = imageUrl(sessionId, name, shot ? "" : agent?.at);
      if (image.getAttribute("src") !== src) image.src = src;
      image.alt = shot ? `Screenshot from ${clockTime(shot.at)}` : `Latest page seen by ${agent?.label || "the agent"}`;
    }
    address.textContent = (shot?.url ?? agent?.url) || "No page open";
    pageTitle.textContent = (shot?.title ?? agent?.title) || "";
    viewing.hidden = !shot;
    viewing.textContent = shot ? `Screenshot · ${clockTime(shot.at)}` : "";
    backToLive.hidden = !shot;
    frame.classList.toggle("pinned", Boolean(shot));
  }

  function renderAgents() {
    agentSelect.hidden = agents.length < 2;
    const values = agents.map((agent) => agent.key).join("|");
    if (agentSelect.dataset.values !== values) {
      agentSelect.replaceChildren(...agents.map((agent) => { const option = element("option", "", agent.label); option.value = agent.key; return option; }));
      agentSelect.dataset.values = values;
    }
    agentSelect.value = currentAgent()?.key || "";
  }

  function renderSteps() {
    empty.hidden = steps.length > 0;
    const multipleAgents = agents.length > 1;
    const rows = steps.slice().reverse().map((entry) => {
      const row = element(entry.screenshot || entry.frame ? "button" : "div", `browser-step${entry.ok === false ? " failed" : ""}`);
      if (row.tagName === "BUTTON") {
        row.type = "button";
        row.title = entry.screenshot ? "Show this screenshot" : "Show this agent's latest page";
        row.addEventListener("click", () => {
          selectedAgent = entry.agentKey;
          pinnedShot = entry.screenshot ? entry : null;
          renderAgents(); renderFrame();
        });
      }
      const head = element("span", "browser-step-head");
      head.append(element("strong", "", stepLabel(entry)), element("time", "", clockTime(entry.at)));
      if (multipleAgents) head.append(element("span", "browser-step-agent", entry.agent || ""));
      row.append(head);
      if (entry.detail) row.append(element("span", "browser-step-detail", entry.detail));
      if (entry.error) row.append(element("span", "browser-step-error", entry.error));
      const badges = stepBadges(entry);
      if (badges.length) {
        const chips = element("span", "browser-step-badges");
        chips.append(...badges.map((badge) => element("i", `badge-${badge.kind}`, badge.text)));
        row.append(chips);
      }
      return row;
    });
    list.replaceChildren(...rows);
  }

  function render() {
    dot.hidden = !unseen || isOpen();
    if (!isOpen()) return;
    renderAgents(); renderFrame(); renderSteps();
  }

  async function poll() {
    const id = sessionId;
    if (!id || inFlight) return;
    inFlight = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/browser?after=${total}`, { cache: "no-store" });
      if (!response.ok || id !== sessionId) return;
      const data = await response.json();
      if (id !== sessionId) return;
      const before = steps.length;
      steps = mergeSteps(steps, data);
      agents = Array.isArray(data.agents) ? data.agents : agents;
      total = Number(data.total) || 0;
      const added = data.reset ? steps.length : steps.length - before;
      // The first load of a chat is history, not new activity.
      const fresh = loaded;
      loaded = true;
      if (fresh && added > 0) {
        if (!isOpen()) unseen = true;
        if (shouldAutoOpen({ open: isOpen(), running: isRunning(), newSteps: added, dismissed: dismissed.has(id),
          narrow: window.matchMedia("(max-width: 760px)").matches })) open();
      }
      render();
    } catch {} finally { inFlight = false; schedule(); }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!sessionId) return;
    const delay = isOpen() ? POLL_OPEN_MS : isRunning() ? POLL_RUNNING_MS : 0;
    if (delay) timer = setTimeout(poll, delay);
  }

  function open() {
    if (!sessionId) return;
    onOpen?.();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.body.classList.add("browser-panel-open");
    unseen = false;
    void signIns.refresh();
    render(); schedule();
  }
  function close({ remember = true } = {}) {
    if (remember && sessionId && isOpen()) dismissed.add(sessionId);
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.body.classList.remove("browser-panel-open");
    render(); schedule();
  }

  button.addEventListener("click", () => {
    if (isOpen()) close();
    else { open(); void poll(); }
  });
  closeButton.addEventListener("click", () => { close(); button.focus(); });
  agentSelect.addEventListener("change", () => { selectedAgent = agentSelect.value; pinnedShot = null; renderFrame(); });
  backToLive.addEventListener("click", () => { pinnedShot = null; renderFrame(); });
  image.addEventListener("click", () => { if (image.src) window.open(image.src, "_blank", "noopener"); });

  return {
    close,
    // Called whenever the selected chat or its running state may have changed.
    sync() {
      const id = getSessionId() || null;
      button.disabled = !id;
      if (id !== sessionId) {
        sessionId = id;
        reset();
        if (!id) close({ remember: false });
        render();
        if (id) void poll();
        return;
      }
      if (!timer && !inFlight) schedule();
    }
  };
}
