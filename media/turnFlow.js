// Turn Flow webview. Renders one agent turn as a flowchart and replays it.
// The extension posts { type: "render", model } (see FlowModel in
// src/turnFlowPanel.ts); this script only ever builds DOM nodes with
// textContent, never HTML strings, because the model carries transcript text.
// @ts-check
(function () {
  "use strict";

  // @ts-ignore — provided by the webview host.
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SPEEDS = [0.5, 1, 2, 4];
  /** Steps that only look around are folded into one node when 3+ in a row. */
  const EXPLORE_KINDS = new Set(["read", "search"]);
  const EXPLORE_GROUP_MIN = 3;

  const KIND_LABEL = {
    read: "Read",
    search: "Search",
    edit: "Edit",
    write: "Write",
    delete: "Delete",
    command: "Run",
    agent: "Subagent",
    web: "Web",
    message: "Agent",
    other: "Tool",
    explore: "Explore",
    prompt: "You",
    result: "Result",
  };
  const STATUS_LABEL = {
    error: "failed",
    rejected: "rejected",
    interrupted: "interrupted",
    running: "running",
  };
  const CHANGE_LETTER = { created: "A", modified: "M", deleted: "D" };
  const CHANGE_LABEL = { created: "Created", modified: "Modified", deleted: "Deleted" };

  /** 16×16 stroke icons: [tag, ...attrs] where path = d, circle = cx cy r. */
  const ICONS = {
    read: [["path", "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"], ["circle", 8, 8, 2]],
    search: [["circle", 7, 7, 4.5], ["path", "M10.4 10.4 14 14"]],
    explore: [["path", "M3 2.5h6.5l3 3v8H3z"], ["path", "M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5"]],
    edit: [["path", "M10.8 2.7l2.5 2.5L6 12.5H3.5V10z"], ["path", "M9.3 4.2l2.5 2.5"]],
    write: [["path", "M3.5 1.5h5.5l3 3v10h-8.5z"], ["path", "M7.75 7.5v4.5M5.5 9.75h4.5"]],
    delete: [["path", "M2.5 4.5h11M6.5 4.5V2.5h3v2M4 4.5l.8 9.5h6.4l.8-9.5"]],
    command: [["path", "M2.5 4l4 4-4 4M8 12.5h5.5"]],
    agent: [["circle", 8, 8, 2.5], ["path", "M8 1.5v3.5M8 11v3.5M1.5 8H5M11 8h3.5"]],
    web: [["circle", 8, 8, 6.5], ["path", "M1.5 8h13M8 1.5c2.3 2.2 2.3 10.8 0 13M8 1.5c-2.3 2.2-2.3 10.8 0 13"]],
    message: [["path", "M2.5 3h11v7.5H8L4.5 13.5v-3h-2z"]],
    other: [["circle", 8, 8, 5.5], ["circle", 8, 8, 1.5]],
    prompt: [["circle", 8, 5, 2.75], ["path", "M2.75 14.25c.6-3.1 2.6-4.75 5.25-4.75s4.65 1.65 5.25 4.75"]],
    result: [["path", "M3 8.5l3.2 3.2L13 4.8"]],
    running: [["path", "M8 1.75a6.25 6.25 0 1 1-6.25 6.25"]],
    warning: [["path", "M8 1.75l6.5 12H1.5z"], ["path", "M8 6.25v3.5M8 11.75v.25"]],
    play: [["path", "M4.5 2.75v10.5L13 8z"]],
    pause: [["path", "M5 3v10M11 3v10"]],
    prev: [["path", "M10 3L5 8l5 5"]],
    next: [["path", "M6 3l5 5-5 5"]],
    stepBack: [["path", "M4 3v10M12.5 3L7 8l5.5 5z"]],
    stepForward: [["path", "M12 3v10M3.5 3L9 8l-5.5 5z"]],
    link: [["path", "M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5V13.5H2.5V4H6.5"]],
  };

  /** @type {any} */
  let model = null;
  /** Display nodes in replay order (prompt first, result last). */
  /** @type {any[]} */
  let flat = [];
  /** pathKey → elements that reference the file (cards and file rows). */
  /** @type {Map<string, HTMLElement[]>} */
  let nodesByFile = new Map();
  /** @type {Map<string, HTMLElement>} */
  let fileRows = new Map();

  const saved = vscode.getState() || {};
  const replay = {
    active: false,
    playing: false,
    cursor: 0,
    speed: SPEEDS.includes(saved.speed) ? saved.speed : 1,
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    timer: undefined,
  };

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "render") {
      render(msg.model);
    }
  });
  document.addEventListener("keydown", onKeyDown);
  vscode.postMessage({ type: "ready" });

  // ---- Rendering --------------------------------------------------------------

  /** @param {any} next */
  function render(next) {
    const sameTurn = model && next && model.key === next.key;
    model = next;
    if (!sameTurn) {
      stopReplay();
    }
    nodesByFile = new Map();
    fileRows = new Map();
    if (!model) {
      app.replaceChildren(
        el("div", { class: "empty" }, "This turn is no longer available. The session or checkpoint may have been removed."),
      );
      return;
    }
    flat = [];
    const prompt = { type: "prompt", seq: 0 };
    flat.push(prompt);
    const roots = layout(model.steps, 0);
    const result = { type: "result", seq: flat.length };
    flat.push(result);

    const flowList = el("ol", { class: "flow", "aria-label": "Steps in this turn" });
    flowList.append(item(prompt));
    for (const node of roots) {
      flowList.append(item(node));
    }
    if (model.trace === "ok" && model.steps.length === 0) {
      flowList.append(el("li", { class: "item" }, el("div", { class: "node kind-note" }, el("div", { class: "note-card" }, "No tool calls recorded in this turn."))));
    }
    flowList.append(item(result));

    app.replaceChildren(
      header(),
      ...banners(),
      toolbar(),
      el(
        "div",
        { class: "main" },
        el("section", { class: "flow-wrap", "aria-label": "Flow" }, flowList),
        filesPanel(),
      ),
    );
    if (replay.active) {
      replay.cursor = Math.min(replay.cursor, flat.length - 1);
    }
    updatePromptToggle();
    applyReplay(false);
  }

  /** Offer "Show full message" only when the clamped prompt overflows. */
  function updatePromptToggle() {
    const prompt = app.querySelector(".prompt");
    const more = /** @type {HTMLElement | null} */ (app.querySelector(".more"));
    if (prompt && more && prompt.classList.contains("clamp")) {
      more.hidden = prompt.scrollHeight <= prompt.clientHeight + 1;
    }
  }
  window.addEventListener("resize", updatePromptToggle);

  /**
   * Turn steps into display nodes in replay order. Consecutive read/search
   * steps fold into one "explore" node; subagent steps nest under theirs.
   * @param {any[]} steps
   * @param {number} depth
   */
  function layout(steps, depth) {
    /** @type {any[]} */
    const out = [];
    let i = 0;
    while (i < steps.length) {
      let j = i;
      while (j < steps.length && EXPLORE_KINDS.has(steps[j].kind)) {
        j++;
      }
      if (j - i >= EXPLORE_GROUP_MIN) {
        const node = { type: "group", steps: steps.slice(i, j), seq: flat.length, depth };
        flat.push(node);
        out.push(node);
        i = j;
        continue;
      }
      const step = steps[i];
      /** @type {any} */
      const node = { type: "step", step, seq: flat.length, depth };
      flat.push(node);
      out.push(node);
      if (step.children && step.children.length) {
        node.children = layout(step.children, depth + 1);
      }
      i++;
    }
    return out;
  }

  function header() {
    const nav = el(
      "div",
      { class: "nav" },
      iconButton("prev", "Previous turn", () => vscode.postMessage({ type: "navigate", delta: -1 }), !model.hasPrev),
      el("span", { class: "position" }, model.position),
      iconButton("next", "Next turn", () => vscode.postMessage({ type: "navigate", delta: 1 }), !model.hasNext),
    );
    const badges = el(
      "div",
      { class: "badges" },
      el("span", { class: `agent agent-${model.agent}` }, agentName(model.agent)),
      model.live ? el("span", { class: "live" }, el("span", { class: "live-dot" }), "Live") : null,
      el("span", { class: "session", title: "Session" }, model.sessionTitle),
    );
    // Every file the agent read, including ones it then changed (the files
    // panel lists those under "Changed", not "Read only").
    const read = countFiles(model.steps, "read");
    const changed = model.changed.length;
    const toolSteps = countSteps(model.steps, (s) => s.kind !== "message");
    const stats = [
      `${toolSteps} step${toolSteps === 1 ? "" : "s"}`,
      `${read} file${read === 1 ? "" : "s"} read`,
      `${changed} file${changed === 1 ? "" : "s"} changed`,
    ];
    if (model.startedAt && model.endedAt && model.endedAt > model.startedAt) {
      stats.push(formatDuration(model.endedAt - model.startedAt));
    }
    stats.push(new Date(model.time).toLocaleString());

    const prompt = el("p", { class: "prompt clamp" }, model.prompt);
    const more = el("button", { class: "text-button more", type: "button" }, "Show full message");
    more.addEventListener("click", () => {
      const clamped = prompt.classList.toggle("clamp");
      more.textContent = clamped ? "Show full message" : "Show less";
    });

    const actions = el("div", { class: "head-actions" });
    if (model.hasSource) {
      const open = el("button", { class: "text-button", type: "button" }, icon("link"), "Open original message");
      open.addEventListener("click", () => vscode.postMessage({ type: "openSource" }));
      actions.append(open);
    }
    return el(
      "header",
      { class: "head" },
      el("div", { class: "head-top" }, nav, badges),
      prompt,
      more,
      el("div", { class: "stats" }, stats.join(" · ")),
      actions,
    );
  }

  function banners() {
    const out = [];
    const unexplained = model.changed.filter((/** @type {any} */ f) => f.explained === false);
    if (unexplained.length) {
      const list = el("ul", { class: "banner-files" });
      for (const f of unexplained) {
        list.append(el("li", {}, fileButton(f.path, f, "code")));
      }
      out.push(
        el(
          "div",
          { class: "banner warn", role: "status" },
          icon("warning"),
          el(
            "div",
            {},
            el("strong", {}, `${unexplained.length} file${unexplained.length === 1 ? "" : "s"} changed without a matching agent edit`),
            el("div", { class: "banner-text" }, "No recorded agent step wrote these. They may have been changed by a shell command, a formatter or build step, another tool, or by you."),
            list,
          ),
        ),
      );
    }
    if (model.trace === "none") {
      out.push(infoBanner("No agent transcript is linked to this turn (a manual checkpoint, or changes made before the first message). Showing the files it changed."));
    } else if (model.trace === "unavailable") {
      out.push(infoBanner("The agent transcript for this turn could not be read. It may have been deleted, moved, or rewritten. Showing the files it changed."));
    } else if (model.truncated) {
      out.push(infoBanner("This turn is very long; only its first steps are shown, and unattributed changes are not checked."));
    } else if (model.live) {
      out.push(infoBanner("This turn is still running. The flow updates as the agent works; unattributed changes are checked once the turn ends."));
    }
    return out;
  }

  /** @param {string} text */
  function infoBanner(text) {
    return el("div", { class: "banner info", role: "note" }, el("div", { class: "banner-text" }, text));
  }

  function toolbar() {
    const total = flat.length - 1;
    const play = el("button", { class: "button primary", type: "button", id: "play" });
    play.addEventListener("click", togglePlay);
    const back = iconButton("stepBack", "Previous step (←)", () => step(-1));
    const forward = iconButton("stepForward", "Next step (→)", () => step(1));
    const speeds = el("div", { class: "speeds", role: "group", "aria-label": "Replay speed" });
    for (const s of SPEEDS) {
      const b = el("button", { class: "speed", type: "button", "aria-pressed": String(s === replay.speed) }, `${s}×`);
      b.addEventListener("click", () => {
        replay.speed = s;
        vscode.setState({ ...(vscode.getState() || {}), speed: s });
        for (const other of speeds.children) {
          other.setAttribute("aria-pressed", String(other === b));
        }
        if (replay.playing) {
          scheduleNext();
        }
      });
      speeds.append(b);
    }
    const scrub = /** @type {HTMLInputElement} */ (
      el("input", { type: "range", min: "0", max: String(total), step: "1", id: "scrub", "aria-label": "Replay position" })
    );
    scrub.addEventListener("input", () => {
      replay.active = true;
      replay.playing = false;
      clearTimeout(replay.timer);
      replay.cursor = Number(scrub.value);
      applyReplay(true);
    });
    const showAll = el("button", { class: "button secondary", type: "button", id: "show-all" }, "Show all");
    showAll.addEventListener("click", () => {
      stopReplay();
      applyReplay(false);
    });
    return el(
      "div",
      { class: "toolbar", role: "toolbar", "aria-label": "Replay" },
      play,
      back,
      forward,
      speeds,
      scrub,
      el("span", { class: "progress", id: "progress" }),
      showAll,
    );
  }

  /** @param {any} node */
  function item(node) {
    const li = el("li", { class: "item" });
    li.append(card(node));
    if (node.children && node.children.length) {
      const lane = el("ol", { class: "lane", "aria-label": "Subagent steps" });
      for (const child of node.children) {
        lane.append(item(child));
      }
      li.append(lane);
    }
    return li;
  }

  /** @param {any} node */
  function card(node) {
    if (node.type === "prompt") {
      return nodeShell(node, "prompt", "ok", [
        el("div", { class: "card-title" }, el("span", { class: "kind" }, KIND_LABEL.prompt), el("span", { class: "title" }, model.label)),
      ], model.startedAt);
    }
    if (node.type === "result") {
      return resultCard(node);
    }
    if (node.type === "group") {
      return groupCard(node);
    }
    return stepCard(node);
  }

  /** @param {any} node */
  function stepCard(node) {
    const s = node.step;
    const body = [];
    const titleText = s.kind === "message" ? s.detail || s.title : s.title;
    const primary = primaryFile(s);
    const title = primary
      ? fileButton(primary.path, primary, "title")
      : el("span", { class: s.kind === "message" ? "title message-text" : "title" }, titleText);
    if (!primary) {
      title.setAttribute("title", s.detail || s.title);
    }
    if (s.kind === "message") {
      title.addEventListener("click", () => title.classList.toggle("expanded"));
    }
    body.push(el("div", { class: "card-title" }, el("span", { class: "kind" }, KIND_LABEL[s.kind] || s.tool), title));

    const meta = [];
    if (s.note) {
      meta.push(el("span", { class: "note" }, s.note));
    }
    if (s.added !== undefined || s.removed !== undefined) {
      meta.push(delta(s.added, s.removed));
    }
    if (STATUS_LABEL[s.status]) {
      meta.push(el("span", { class: `status status-${s.status}` }, STATUS_LABEL[s.status]));
    }
    if (s.userModified) {
      meta.push(el("span", { class: "status status-user" }, "edited by you"));
    }
    if (s.children && s.children.length) {
      meta.push(el("span", { class: "note" }, `${countSteps(s.children, () => true)} subagent steps`));
    }
    const extraFiles = s.files.filter((/** @type {any} */ f) => f !== primary);
    if (meta.length || extraFiles.length) {
      const metaRow = el("div", { class: "meta" }, ...meta);
      for (const f of extraFiles) {
        metaRow.append(fileChip(f));
      }
      body.push(metaRow);
    }
    if (s.detail && s.kind !== "message" && s.detail !== s.title) {
      body.push(
        el("details", { class: "detail" }, el("summary", {}, s.kind === "agent" ? "Prompt" : "Full command"), el("pre", {}, s.detail)),
      );
    }
    const shell = nodeShell(node, s.kind, s.status, body, s.timestamp);
    registerFiles(shell, s.files);
    return shell;
  }

  /** @param {any} node */
  function groupCard(node) {
    const files = [];
    const searches = [];
    for (const s of node.steps) {
      if (s.files.length) {
        files.push(...s.files);
      } else {
        searches.push(s.title);
      }
    }
    const parts = [];
    if (files.length) {
      parts.push(`read ${files.length} file${files.length === 1 ? "" : "s"}`);
    }
    if (searches.length) {
      parts.push(`searched ${searches.length} time${searches.length === 1 ? "" : "s"}`);
    }
    const summary = parts.join(", ");
    const chips = el("div", { class: "meta" });
    for (const f of files) {
      chips.append(fileChip(f));
    }
    for (const q of searches) {
      chips.append(el("span", { class: "chip chip-search", title: q }, q));
    }
    const failed = node.steps.some((/** @type {any} */ s) => s.status === "error");
    const shell = nodeShell(
      node,
      "explore",
      failed ? "error" : "ok",
      [el("div", { class: "card-title" }, el("span", { class: "kind" }, KIND_LABEL.explore), el("span", { class: "title" }, summary.charAt(0).toUpperCase() + summary.slice(1))), chips],
      node.steps[0].timestamp,
    );
    registerFiles(shell, files);
    return shell;
  }

  /** @param {any} node */
  function resultCard(node) {
    const body = [];
    if (model.live) {
      body.push(el("div", { class: "card-title" }, el("span", { class: "kind" }, "Now"), el("span", { class: "title" }, "Agent is working…")));
    } else {
      const n = model.changed.length;
      body.push(
        el(
          "div",
          { class: "card-title" },
          el("span", { class: "kind" }, KIND_LABEL.result),
          el("span", { class: "title" }, n ? `${n} file${n === 1 ? "" : "s"} changed` : "No file changes"),
        ),
      );
    }
    if (model.changed.length) {
      const chips = el("div", { class: "meta" });
      for (const f of model.changed) {
        chips.append(fileChip({ path: f.path, access: "write", inWorkspace: true, change: f.status }, f));
      }
      body.push(chips);
    }
    const shell = nodeShell(node, model.live ? "running" : "result", model.live ? "running" : "ok", body, model.endedAt);
    registerFiles(shell, model.changed.map((/** @type {any} */ f) => ({ path: f.path, access: "write" })));
    return shell;
  }

  /**
   * @param {any} node
   * @param {string} kind
   * @param {string} status
   * @param {any[]} body
   * @param {number | undefined} timestamp
   */
  function nodeShell(node, kind, status, body, timestamp) {
    const iconName = status === "running" ? "running" : kind in ICONS ? kind : "other";
    const time = relativeTime(timestamp);
    return el(
      "div",
      { class: `node kind-${kind} status-${status}`, "data-seq": String(node.seq) },
      el(
        "div",
        { class: "card" },
        el("span", { class: "badge", "aria-hidden": "true" }, icon(iconName)),
        el("div", { class: "card-body" }, ...body),
        time ? el("span", { class: "time", title: timestamp ? new Date(timestamp).toLocaleTimeString() : "" }, time) : null,
      ),
    );
  }

  function filesPanel() {
    const sections = [];
    if (model.changed.length) {
      const list = el("ul", { class: "file-list" });
      for (const f of model.changed) {
        list.append(fileRow(f, "write"));
      }
      sections.push(el("section", {}, el("h2", {}, "Changed", el("span", { class: "count" }, String(model.changed.length))), list));
    }
    if (model.read.length) {
      const list = el("ul", { class: "file-list" });
      for (const f of model.read) {
        list.append(fileRow(f, "read"));
      }
      sections.push(el("section", {}, el("h2", {}, "Read only", el("span", { class: "count" }, String(model.read.length))), list));
    }
    if (!sections.length) {
      sections.push(el("p", { class: "muted" }, model.live ? "No files touched yet." : "No files were touched in this turn."));
    }
    return el("aside", { class: "files", "aria-label": "Files" }, ...sections);
  }

  /**
   * @param {any} f
   * @param {"read" | "write"} access
   */
  function fileRow(f, access) {
    const key = pathKey(f.path);
    const { name, dir } = splitPath(f.path);
    const button = el(
      "button",
      { class: "file-row", type: "button", title: fileTitle(f) },
      f.status
        ? el("span", { class: `letter change-${f.status}` }, CHANGE_LETTER[f.status])
        : el("span", { class: "letter change-read" }, "R"),
      el("span", { class: "file-name" }, name),
      el("span", { class: "file-dir" }, dir),
      f.added !== undefined ? delta(f.added, f.removed) : null,
      f.explained === false ? el("span", { class: "flag", title: "Changed without a matching agent edit" }, icon("warning")) : null,
    );
    button.addEventListener("click", () => openPath(f.path, f));
    button.addEventListener("mouseenter", () => highlightFile(key, true));
    button.addEventListener("mouseleave", () => highlightFile(key, false));
    button.addEventListener("focus", () => highlightFile(key, true));
    button.addEventListener("blur", () => highlightFile(key, false));
    const li = el("li", { class: `file access-${access}${f.explained === false ? " unexplained" : ""}${f.inWorkspace ? "" : " outside"}` }, button);
    fileRows.set(key, li);
    return li;
  }

  /**
   * A clickable file reference inside a card.
   * @param {any} f step file
   * @param {any} [changedEntry] the turn's change entry for this file, if any
   */
  function fileChip(f, changedEntry) {
    const changed = changedEntry || changedFile(f.path);
    const outcome = f.access === "write" ? writeOutcome(f, changed) : "";
    const label = splitPath(f.path).name;
    const chip = fileButton(f.path, changed || f, `chip chip-${f.access}${outcome ? ` outcome-${outcome}` : ""}`);
    chip.textContent = "";
    if (f.access === "write" && f.change) {
      chip.append(el("span", { class: `letter change-${f.change}` }, CHANGE_LETTER[f.change]));
    }
    chip.append(label);
    chip.setAttribute("title", `${f.path}${outcomeText(outcome)}`);
    return chip;
  }

  /**
   * @param {string} path
   * @param {any} entry changed file entry or step file
   * @param {string} className
   */
  function fileButton(path, entry, className) {
    const b = el("button", { class: `link ${className}`, type: "button", title: path }, path);
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      openPath(path, entry);
    });
    return b;
  }

  /**
   * Changed files open their diff for this turn; everything else opens.
   * @param {string} path
   * @param {any} entry
   */
  function openPath(path, entry) {
    const changed = changedFile(path);
    if (changed && changed.canDiff) {
      vscode.postMessage({ type: "openDiff", path: changed.path });
    } else if (!entry || entry.status !== "deleted") {
      vscode.postMessage({ type: "openFile", path });
    }
  }

  // ---- Replay -----------------------------------------------------------------

  function togglePlay() {
    if (replay.playing) {
      replay.playing = false;
      clearTimeout(replay.timer);
      updateControls();
      return;
    }
    if (!replay.active || replay.cursor >= flat.length - 1) {
      replay.active = true;
      replay.cursor = 0;
      applyReplay(true);
    }
    replay.playing = true;
    scheduleNext();
    updateControls();
  }

  /** @param {number} delta */
  function step(delta) {
    replay.playing = false;
    clearTimeout(replay.timer);
    if (!replay.active) {
      replay.active = true;
      replay.cursor = delta > 0 ? 0 : flat.length - 1;
    } else {
      replay.cursor = Math.max(0, Math.min(flat.length - 1, replay.cursor + delta));
    }
    applyReplay(true);
  }

  function stopReplay() {
    replay.active = false;
    replay.playing = false;
    replay.cursor = 0;
    clearTimeout(replay.timer);
  }

  function scheduleNext() {
    clearTimeout(replay.timer);
    if (!replay.playing) {
      return;
    }
    if (replay.cursor >= flat.length - 1) {
      // A live turn keeps going: wait at the end for new steps.
      if (!model || !model.live) {
        replay.playing = false;
        updateControls();
        return;
      }
      replay.timer = setTimeout(scheduleNext, 1000);
      return;
    }
    replay.timer = setTimeout(() => {
      replay.cursor++;
      applyReplay(true);
      scheduleNext();
    }, delayBefore(replay.cursor + 1) / replay.speed);
  }

  /**
   * Pace by the real gap between steps, compressed: a long command still
   * feels longer than a quick read, but nothing waits more than 2s.
   * @param {number} seq
   */
  function delayBefore(seq) {
    const prev = timeOf(flat[seq - 1]);
    const cur = timeOf(flat[seq]);
    const base = 650;
    if (prev && cur && cur >= prev) {
      return Math.min(2000, base + 260 * Math.log2(1 + (cur - prev) / 1000));
    }
    return base;
  }

  /** @param {any} node */
  function timeOf(node) {
    if (!node || !model) {
      return undefined;
    }
    if (node.type === "prompt") {
      return model.startedAt;
    }
    if (node.type === "result") {
      return model.endedAt;
    }
    return node.type === "group" ? node.steps[0].timestamp : node.step.timestamp;
  }

  /** @param {boolean} animate */
  function applyReplay(animate) {
    const flowWrap = app.querySelector(".flow-wrap");
    if (flowWrap) {
      flowWrap.classList.toggle("replaying", replay.active);
    }
    /** @type {HTMLElement | undefined} */
    let activeEl;
    for (const node of app.querySelectorAll(".node[data-seq]")) {
      const seq = Number(/** @type {HTMLElement} */ (node).dataset.seq);
      node.classList.toggle("future", replay.active && seq > replay.cursor);
      const active = replay.active && seq === replay.cursor;
      node.classList.toggle("active", active);
      if (active) {
        activeEl = /** @type {HTMLElement} */ (node);
      }
    }
    // Files light up as the replay first touches them.
    const touched = new Set();
    if (replay.active) {
      for (let i = 0; i <= replay.cursor && i < flat.length; i++) {
        for (const f of filesOf(flat[i])) {
          touched.add(pathKey(f.path));
        }
      }
    }
    for (const [key, row] of fileRows) {
      row.classList.toggle("untouched", replay.active && !touched.has(key));
    }
    if (animate && replay.active) {
      for (const f of filesOf(flat[replay.cursor])) {
        pulse(fileRows.get(pathKey(f.path)), f.access);
      }
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      }
    }
    updateControls();
  }

  /** @param {any} node */
  function filesOf(node) {
    if (!node || !model) {
      return [];
    }
    if (node.type === "step") {
      return node.step.files;
    }
    if (node.type === "group") {
      return node.steps.flatMap((/** @type {any} */ s) => s.files);
    }
    if (node.type === "result") {
      return model.changed.map((/** @type {any} */ f) => ({ path: f.path, access: "write" }));
    }
    return [];
  }

  /**
   * @param {HTMLElement | undefined} row
   * @param {string} access
   */
  function pulse(row, access) {
    if (!row || reduceMotion) {
      return;
    }
    const cls = access === "write" ? "pulse-write" : "pulse-read";
    row.classList.remove("pulse-read", "pulse-write");
    void row.offsetWidth; // Restart the animation.
    row.classList.add(cls);
  }

  function updateControls() {
    const play = app.querySelector("#play");
    const scrub = /** @type {HTMLInputElement | null} */ (app.querySelector("#scrub"));
    const progress = app.querySelector("#progress");
    const showAll = /** @type {HTMLButtonElement | null} */ (app.querySelector("#show-all"));
    if (!play || !scrub || !progress || !showAll) {
      return;
    }
    const total = flat.length - 1;
    const finished = replay.active && !replay.playing && replay.cursor >= total;
    play.replaceChildren(
      icon(replay.playing ? "pause" : "play"),
      replay.playing ? "Pause" : finished ? "Replay again" : replay.active ? "Resume" : "Replay",
    );
    scrub.value = String(replay.active ? replay.cursor : total);
    progress.textContent = replay.active ? `${replay.cursor} / ${total}` : `${total} / ${total}`;
    showAll.disabled = !replay.active;
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, summary, details pre")) {
      return; // Let focused controls handle their own keys.
    }
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowRight") {
      step(1);
    } else if (event.key === "ArrowLeft") {
      step(-1);
    } else if (event.key === "Escape" && replay.active) {
      stopReplay();
      applyReplay(false);
    }
  }

  // ---- Hover links between cards and files -------------------------------------

  /**
   * @param {HTMLElement} shell
   * @param {any[]} files
   */
  function registerFiles(shell, files) {
    const keys = new Set(files.map((f) => pathKey(f.path)));
    for (const key of keys) {
      const list = nodesByFile.get(key) || [];
      list.push(shell);
      nodesByFile.set(key, list);
    }
    if (!keys.size) {
      return;
    }
    shell.addEventListener("mouseenter", () => keys.forEach((k) => fileRows.get(k)?.classList.add("linked")));
    shell.addEventListener("mouseleave", () => keys.forEach((k) => fileRows.get(k)?.classList.remove("linked")));
  }

  /**
   * @param {string} key
   * @param {boolean} on
   */
  function highlightFile(key, on) {
    const flowWrap = app.querySelector(".flow-wrap");
    flowWrap?.classList.toggle("focusing", on);
    for (const node of nodesByFile.get(key) || []) {
      node.classList.toggle("linked", on);
    }
  }

  // ---- Helpers ------------------------------------------------------------------

  /** The file a step's title should link to: what it changed, else what it read. */
  /** @param {any} s */
  function primaryFile(s) {
    if (!s.files.length || s.kind === "command") {
      return undefined;
    }
    return s.files.find((/** @type {any} */ f) => f.access === "write") || s.files[0];
  }

  /** @param {string} path */
  function changedFile(path) {
    const key = pathKey(path);
    return model.changed.find((/** @type {any} */ f) => pathKey(f.path) === key);
  }

  /**
   * What became of a file a step wrote, relative to the turn's net changes.
   * @param {any} f
   * @param {any} changed
   */
  function writeOutcome(f, changed) {
    if (changed) {
      return "changed";
    }
    if (!f.inWorkspace) {
      return "outside";
    }
    if (model.ignored.includes(f.path)) {
      return "ignored";
    }
    return model.live ? "" : "unchanged";
  }

  /** @param {string} outcome */
  function outcomeText(outcome) {
    switch (outcome) {
      case "outside":
        return " — outside the workspace, not tracked";
      case "ignored":
        return " — ignored by Agent Change Guard, not tracked";
      case "unchanged":
        return " — no net change by the end of the turn";
      default:
        return "";
    }
  }

  /** @param {any} f */
  function fileTitle(f) {
    const parts = [f.path];
    if (f.status) {
      parts.push(CHANGE_LABEL[f.status]);
    }
    if (f.explained === false) {
      parts.push("No agent step wrote this file");
    }
    if (f.status && !f.canDiff) {
      parts.push("Too large to diff");
    }
    return parts.join(" — ");
  }

  /**
   * @param {number | undefined} added
   * @param {number | undefined} removed
   */
  function delta(added, removed) {
    return el(
      "span",
      { class: "delta" },
      el("span", { class: "added" }, `+${added || 0}`),
      el("span", { class: "removed" }, `−${removed || 0}`),
    );
  }

  /**
   * @param {any[]} steps
   * @param {(s: any) => boolean} predicate
   */
  function countSteps(steps, predicate) {
    let n = 0;
    for (const s of steps) {
      if (predicate(s)) {
        n++;
      }
      if (s.children) {
        n += countSteps(s.children, predicate);
      }
    }
    return n;
  }

  /**
   * Distinct files the steps (and subagent steps) accessed this way.
   * @param {any[]} steps
   * @param {"read" | "write"} access
   */
  function countFiles(steps, access) {
    const keys = new Set();
    /** @param {any[]} list */
    const visit = (list) => {
      for (const s of list) {
        for (const f of s.files) {
          if (f.access === access) {
            keys.add(pathKey(f.path));
          }
        }
        if (s.children) {
          visit(s.children);
        }
      }
    };
    visit(steps);
    return keys.size;
  }

  /** @param {number | undefined} timestamp */
  function relativeTime(timestamp) {
    if (!timestamp || !model.startedAt || timestamp < model.startedAt) {
      return "";
    }
    const seconds = Math.round((timestamp - model.startedAt) / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `+${m}:${String(s).padStart(2, "0")}`;
  }

  /** @param {number} ms */
  function formatDuration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    }
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  /** @param {string} agent */
  function agentName(agent) {
    return { claude: "Claude Code", codex: "Codex", cursor: "Cursor", manual: "Manual" }[agent] || agent;
  }

  /** Same rule as pathKey in src/turnTrace.ts: case-insensitive on macOS/Windows. */
  /** @param {string} p */
  function pathKey(p) {
    return /Mac|Win/.test(navigator.platform) ? p.toLowerCase() : p;
  }

  /** @param {string} p */
  function splitPath(p) {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i === -1 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
  }

  /**
   * @param {string} name
   * @param {string} label
   * @param {() => void} onClick
   * @param {boolean} [disabled]
   */
  function iconButton(name, label, onClick, disabled) {
    const b = el("button", { class: "icon-button", type: "button", title: label, "aria-label": label }, icon(name));
    if (disabled) {
      b.setAttribute("disabled", "");
    }
    b.addEventListener("click", onClick);
    return b;
  }

  /** @param {string} name */
  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, ...args] of ICONS[name] || ICONS.other) {
      const shape = document.createElementNS(ns, String(tag));
      if (tag === "circle") {
        shape.setAttribute("cx", String(args[0]));
        shape.setAttribute("cy", String(args[1]));
        shape.setAttribute("r", String(args[2]));
      } else {
        shape.setAttribute("d", String(args[0]));
      }
      svg.append(shape);
    }
    return svg;
  }

  /**
   * Create an element. Children may be nodes, strings (as text), or null.
   * @param {string} tag
   * @param {Record<string, string>} attrs
   * @param {...any} children
   * @returns {HTMLElement}
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      node.setAttribute(name, value);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
})();
