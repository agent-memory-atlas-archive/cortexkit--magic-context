// Fixture-only captures for OpenCode and Pi project session pages.
// No native backend, database, home-directory config, or session files are read.
// Run: bun packages/dashboard/scripts/session-page-browser.ts <output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Screenshot directory required");
mkdirSync(output, { recursive: true });
const dashboard = resolve(import.meta.dir, "..");
const port = 1431;
const projectIdentity = "git:fixture-session-pages";
const sessionRows = [
  {
    harness: "opencode",
    session_id: "oc-fixture-session",
    title: "Fixture OpenCode session with a shared header row",
    project_identity: projectIdentity,
    project_display: "fixture-project",
    last_activity_ms: Date.UTC(2026, 4, 1, 16, 48),
    is_subagent: false,
  },
  {
    harness: "pi",
    session_id: "pi-fixture-session",
    title: "Fixture Pi session with a long JSONL path",
    project_identity: projectIdentity,
    project_display: "fixture-project",
    last_activity_ms: Date.UTC(2026, 4, 1, 16, 48),
    is_subagent: false,
  },
];
const compartments = [
  {
    id: 1,
    session_id: "fixture-session",
    sequence: 1,
    start_message: 1,
    end_message: 18,
    start_message_id: "fixture-start",
    end_message_id: "fixture-end",
    title: "Mapped a session boundary to the fixture transcript",
    content: "Reviewed the project fixture and recorded the outcome.",
    created_at: Date.UTC(2026, 4, 1, 16, 40),
    start_time: Date.UTC(2026, 4, 1, 16, 21),
    end_time: Date.UTC(2026, 4, 1, 16, 48),
    importance: 72,
    episode_type: "research,decision",
    p1: "Reviewed the project fixture and recorded the outcome.",
    p2: "Reviewed fixture.",
    p3: "Fixture review.",
    p4: "review",
    legacy: 0,
  },
  {
    id: 2,
    session_id: "fixture-session",
    sequence: 2,
    start_message: 19,
    end_message: 24,
    start_message_id: "fixture-second-start",
    end_message_id: "fixture-second-end",
    title: "Confirmed the final implementation checks",
    content: "Confirmed the implementation and checks.",
    created_at: Date.UTC(2026, 4, 1, 16, 48),
    start_time: Date.UTC(2026, 4, 1, 16, 49),
    end_time: Date.UTC(2026, 4, 1, 17, 2),
    importance: 50,
    episode_type: "verification",
    p1: "Confirmed the implementation and checks.",
    p2: "Confirmed checks.",
    p3: "Checks.",
    p4: "checks",
    legacy: 0,
  },
].map((comp) => ({ ...comp, session_id: "fixture-session" }));
const longPiPath = "/Users/fixture/.pi/agent/sessions/-Users-fixture-Work-fixture-project/2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl";
const sessionDetail = (isPi: boolean) => ({
  harness: isPi ? "pi" : "opencode",
  session_id: isPi ? "pi-fixture-session" : "oc-fixture-session",
  title: isPi ? "Fixture Pi session with a long JSONL path" : "Fixture OpenCode session with a shared header row",
  project_identity: projectIdentity,
  project_display: "fixture-project",
  project_path: "/Users/fixture/Work/fixture-project",
  opencode_session_json: isPi ? null : { id: "oc-fixture-session" },
  pi_jsonl_path: isPi ? longPiPath : null,
  messages_count: 24,
  cache_events_count: 0,
  historian_runs: 0,
  compartments: compartments.map((comp) => ({
    ...comp,
    session_id: isPi ? "pi-fixture-session" : "oc-fixture-session",
    // Default Pi fixture data has unresolved boundary timestamps. Set the
    // screenshot flag to supply values from a JSONL timestamp lookup.
    ...(isPi && !process.env.SESSION_PAGE_EXPECT_PI_DATES ? { start_time: null, end_time: null } : {}),
  })),
  facts: [],
  notes: [],
  meta: null,
  token_breakdown: null,
  pi_compaction_entries: [],
});
const project = {
  identity: projectIdentity,
  display_name: "fixture-project",
  primary_path: "/Users/fixture/Work/fixture-project",
  harnesses: ["opencode", "pi"],
  session_count: sessionRows.length,
  memory_count: 0,
  workspace_name: null,
  last_activity_ms: Date.UTC(2026, 4, 1, 16, 48),
};
const projectInfo = { identity: projectIdentity, label: "fixture-project", path: project.primary_path };
const health = { exists: true, path: "/fixture/context.db", size_bytes: 0, wal_size_bytes: 0, table_counts: [] };
const responses = {
  get_db_health: health,
  get_model_catalogs: { opencode: [], pi: [], omp: [], opencodeVariants: {} },
  get_opencode_install_state: "cli",
  get_project_cards: [project],
  get_projects: [projectInfo],
  enumerate_memory_projects: [],
  enumerate_projects: [],
  list_sessions_paged: { rows: sessionRows, total: sessionRows.length, has_more: false, conditions: [] },
  get_session_messages: [],
  get_smart_notes: [],
  get_subagent_invocations: [],
  get_subagent_totals_by_subagent: [],
};
const preload = (theme: string) => `(() => {
  try { localStorage.setItem('magic-context-dashboard.theme', ${JSON.stringify(theme)}); } catch {}
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:updater|check') return null;
      if (cmd.startsWith('plugin:')) return null;
      if (cmd === 'get_session_detail') return ${JSON.stringify(sessionDetail(false))}.session_id === args.sessionId
        ? ${JSON.stringify(sessionDetail(false))}
        : ${JSON.stringify(sessionDetail(true))};
      return cmd in ${JSON.stringify(responses)} ? ${JSON.stringify(responses)}[cmd] : [];
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})()`;

const vite = Bun.spawn(["timeout", "240s", join(dashboard, "node_modules/.bin/vite"), "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
  cwd: dashboard,
  stdout: "pipe",
  stderr: "inherit",
});
const chrome = Bun.spawn(["timeout", "240s", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${join(output, "chrome-profile")}`, "about:blank"], {
  stdout: "ignore",
  stderr: "pipe",
});
let socket: WebSocket | undefined;
try {
  let viteOutput = "";
  for await (const chunk of vite.stdout) {
    viteOutput += new TextDecoder().decode(chunk);
    if (viteOutput.includes(`http://127.0.0.1:${port}`)) break;
  }
  let chromeOutput = "";
  let endpoint = "";
  for await (const chunk of chrome.stderr) {
    chromeOutput += new TextDecoder().decode(chunk);
    endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(chromeOutput)?.[1] ?? "";
    if (endpoint) break;
  }
  if (!endpoint) throw new Error("Chrome debugging endpoint unavailable");
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = () => reject(new Error("Chrome connection failed"));
  });
  let commandId = 0;
  const pending = new Map<number, (result: any) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (pending.has(message.id)) {
      const done = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) throw new Error(JSON.stringify(message.error));
      done(message.result);
    }
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
    new Promise((resolve) => {
      const id = ++commandId;
      pending.set(id, resolve);
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const attached = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const browserSession = attached.sessionId;
  await send("Page.enable", {}, browserSession);
  await send("Runtime.enable", {}, browserSession);
  const evalPage = async <T>(expression: string) => {
    const response = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, browserSession);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const waitFor = (selector: string) => evalPage(`new Promise((done, fail) => {
    const find = () => document.querySelector(${JSON.stringify(selector)});
    if (find()) return done(true);
    const observer = new MutationObserver(() => { if (find()) { observer.disconnect(); done(true); } });
    observer.observe(document, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); fail(new Error('selector timeout: ' + ${JSON.stringify(selector)})); }, 15000);
  })`);
  const settle = () => evalPage("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200))))");
  for (const theme of ["light", "dark"] as const) {
    const preloadId = await send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: preload(theme) }, browserSession);
    await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false }, browserSession);
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, browserSession);
    await waitFor(".project-card");
    await evalPage("document.querySelector('.project-card').click()");
    await waitFor(".project-detail-body .scroll-area button.card");
    for (const [kind, title] of [["opencode", "Fixture OpenCode session"], ["pi", "Fixture Pi session with a long JSONL path"]] as const) {
      await evalPage(`(() => {
        const row = [...document.querySelectorAll('.project-detail-body .scroll-area button.card')]
          .find((element) => element.textContent.includes(${JSON.stringify(title)}));
        if (!row) throw new Error('missing session row: ' + ${JSON.stringify(title)} + ' body=' + document.body.innerText.slice(0, 1000));
        row.click();
      })()`);
      await waitFor(".tab-pill");
      await waitFor(".section-header");
      if (kind === "pi") await waitFor(".card-meta");
      await settle();
      if (kind === "pi" && process.env.SESSION_PAGE_EXPECT_PI_DATES) {
        const visibleDate = await evalPage("[...document.querySelectorAll('.list-gap button.card')].some((card) => card.innerText.includes(' → '))");
        if (!visibleDate) throw new Error("Pi compartment date fixture was not rendered");
        const pathIsContained = await evalPage(`(() => {
          const path = [...document.querySelectorAll('.card-meta .id-text')].find((element) => element.title === ${JSON.stringify(longPiPath)});
          const card = path?.closest('.card');
          if (!path || !card) return false;
          const pathRect = path.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();
          return pathRect.right <= cardRect.right && cardRect.right <= innerWidth;
        })()`);
        if (!pathIsContained) throw new Error("Pi JSONL path escapes its header card at 900px");
        const headerAligned = await evalPage(`(() => {
          const header = document.querySelector('.section-header h1');
          const back = header?.querySelector('.btn.sm');
          const badge = header?.querySelector('.pill');
          const title = header?.querySelector(':scope > span > span:last-child');
          if (!back || !badge || !title) return false;
          const centers = [back, badge, title].map((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top + rect.height / 2;
          });
          return Math.max(...centers) - Math.min(...centers) < 4;
        })()`);
        if (!headerAligned) throw new Error("Session header controls do not share a centered row");
      }
      const screenshot = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, browserSession);
      const filename = join(output, `${theme}-900-${kind}.png`);
      writeFileSync(filename, Buffer.from(screenshot.data, "base64"));
      console.log(`captured ${filename}`);
      if (kind === "opencode") {
        await evalPage("document.querySelector('.section-header .btn.sm').click()");
        await waitFor(".project-detail-body .scroll-area button.card");
      }
    }
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preloadId.identifier }, browserSession);
  }
} finally {
  socket?.close();
  chrome.kill();
  vite.kill();
  await Promise.all([chrome.exited, vite.exited]);
}
