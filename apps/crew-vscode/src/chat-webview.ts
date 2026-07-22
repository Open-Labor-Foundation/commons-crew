// The commons-crew webview: a self-contained, theme-aware surface with the
// session history rail and the chat laid out SIDE BY SIDE in a single view.
// All CSS/JS is inlined with a nonce so it satisfies the webview CSP.

export function chatWebviewHtml(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: row;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }

  /* ---- history rail (left) ---- */
  #rail {
    flex: 0 0 120px; min-width: 96px; max-width: 40%;
    display: flex; flex-direction: column;
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-input-border));
    background: var(--vscode-sideBarSectionHeader-background, transparent);
  }
  #railHead {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .05em; opacity: .7;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border));
  }
  #railHead button {
    padding: 2px 8px; font-size: 11px;
  }
  #railSearch {
    margin: 6px 6px 2px; padding: 4px 7px; font-size: 12px;
    font-family: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder)); border-radius: 5px;
  }
  #railSearch:focus { outline: 1px solid var(--vscode-focusBorder); }
  #sessions { flex: 1 1 auto; overflow-y: auto; padding: 4px; }
  .session {
    padding: 6px 8px; border-radius: 6px; cursor: pointer;
    display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px;
    position: relative;
  }
  .session:hover { background: var(--vscode-list-hoverBackground); }
  .session.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .session .row { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  .session .t { flex: 1 1 auto; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session .m { font-size: 10px; opacity: .6; }
  .session .del {
    flex: 0 0 auto; opacity: 0; padding: 1px 5px; font-size: 11px; line-height: 1.4;
    border: none; background: transparent; color: inherit;
  }
  .session:hover .del { opacity: .6; }
  .session .del:hover { opacity: 1 !important; color: var(--vscode-errorForeground); }
  .session .del.confirm { opacity: 1; color: var(--vscode-errorForeground); }
  #railEmpty { padding: 10px; font-size: 12px; opacity: .55; }

  /* ---- chat (right) ---- */
  #chat { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  #transcript { flex: 1 1 auto; overflow-y: auto; padding: 12px 12px 4px; }
  .msg { margin: 0 0 12px; line-height: 1.45; position: relative; }
  .msg .who {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; margin-bottom: 3px;
  }
  .msg .copyBtn {
    opacity: 0; padding: 0 5px; font-size: 10px; text-transform: none; letter-spacing: 0;
    border: none; background: transparent; color: inherit; cursor: pointer;
  }
  .msg:hover .copyBtn { opacity: .6; }
  .msg .copyBtn:hover { opacity: 1 !important; }
  .msg .copyBtn.copied { opacity: 1 !important; color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 8px; padding: 7px 10px; white-space: pre-wrap; word-break: break-word;
  }
  .assistant .bubble { white-space: pre-wrap; word-break: break-word; }
  .event {
    font-size: 12px; opacity: .8; padding: 2px 0 2px 6px;
    border-left: 2px solid var(--vscode-panel-border, var(--vscode-input-border));
    margin: 2px 0; white-space: pre-wrap; word-break: break-word;
  }
  .event.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .event.err { color: var(--vscode-errorForeground); }
  .event.think {
    font-style: italic; opacity: .75;
    border-left-color: var(--vscode-charts-purple, var(--vscode-focusBorder));
  }
  .event.think .more {
    display: block; font-style: normal; opacity: .8; cursor: pointer;
    margin-top: 2px; text-decoration: underline; width: fit-content;
  }
  .status { font-size: 12px; opacity: .7; font-style: italic; padding: 2px 0; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; padding: 4px 0; }
  .approval {
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border-radius: 8px; padding: 9px 10px; margin: 4px 0 10px;
  }
  .approval .title { font-weight: 600; margin-bottom: 3px; }
  .approval .detail { font-size: 12px; opacity: .8; margin-bottom: 8px; word-break: break-word; }
  .approval .actions { display: flex; gap: 8px; }
  .approval.resolved { opacity: .55; }
  button {
    font-family: inherit; font-size: 12px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px;
    padding: 5px 12px;
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #welcome { padding: 18px 12px; opacity: .8; font-size: 13px; line-height: 1.5; }
  #welcome h3 { margin: 0 0 6px; font-size: 14px; }
  #welcome code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  #composer {
    flex: 0 0 auto; display: flex; gap: 6px; align-items: flex-end;
    padding: 8px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  #input {
    flex: 1 1 auto; resize: none; min-height: 34px; max-height: 160px;
    font-family: inherit; font-size: 13px; line-height: 1.4; padding: 7px 9px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder)); border-radius: 6px;
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  #send:disabled { opacity: .5; cursor: default; }
  #stop { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  #usageBar {
    padding: 2px 10px; font-size: 10.5px; opacity: .55; text-align: right;
    min-height: 14px;
  }

  /* When the view is too narrow for two columns, collapse the rail. */
  @media (max-width: 220px) {
    #rail { display: none; }
  }
</style>
</head>
<body>
  <aside id="rail">
    <div id="railHead">
      <span>History</span>
      <button id="newBtn" class="secondary" title="Start a new chat">New</button>
    </div>
    <input id="railSearch" type="text" placeholder="Search…" />
    <div id="sessions"><div id="railEmpty">No chats yet.</div></div>
  </aside>
  <section id="chat">
    <div id="transcript">
      <div id="welcome">
        <h3>commons-crew</h3>
        Ask a team of governed specialists — materialized from the labor-commons catalog —
        to work a task in this folder. They read, write, and run for real, and pause for your
        approval before side effects.<br/><br/>
        Try: <code>Add a /health endpoint with a test.</code>
      </div>
    </div>
    <div id="usageBar"></div>
    <div id="composer">
      <textarea id="input" placeholder="Message commons-crew…  (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
      <button id="stop" class="secondary" title="Stop the current run" hidden>Stop</button>
      <button id="send" class="primary">Send</button>
    </div>
  </section>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const transcript = document.getElementById("transcript");
  const sessionsEl = document.getElementById("sessions");
  const railSearch = document.getElementById("railSearch");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const stopBtn = document.getElementById("stop");
  const usageBar = document.getElementById("usageBar");
  document.getElementById("newBtn").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  let busy = false;
  let statusEl = null;
  let welcome = document.getElementById("welcome");
  let allSessions = [];
  let activeIdCache = null;
  const sentHistory = [];
  let historyIndex = -1;
  let historyDraft = "";

  function clearWelcome() { if (welcome && welcome.parentNode) { welcome.remove(); } }
  function atBottom() { return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40; }
  function scroll() { transcript.scrollTop = transcript.scrollHeight; }

  function showWelcome() {
    transcript.innerHTML = "";
    const div = document.createElement("div");
    div.id = "welcome";
    div.innerHTML =
      '<h3>commons-crew</h3>Ask a team of governed specialists — materialized from the labor-commons catalog — ' +
      'to work a task in this folder. They read, write, and run for real, and pause for your approval before side effects.' +
      '<br/><br/>Try: <code>Add a /health endpoint with a test.</code>';
    transcript.appendChild(div);
    welcome = div;
  }

  function renderSessions(list, activeId) {
    if (list) allSessions = list;
    if (activeId !== undefined) activeIdCache = activeId;
    const query = railSearch.value.trim().toLowerCase();
    const filtered = query
      ? allSessions.filter((s) => (s.title || "").toLowerCase().includes(query))
      : allSessions;

    sessionsEl.innerHTML = "";
    if (filtered.length === 0) {
      const e = document.createElement("div"); e.id = "railEmpty";
      e.textContent = allSessions.length === 0 ? "No chats yet." : "No matches.";
      sessionsEl.appendChild(e); return;
    }
    for (const s of filtered) {
      const row = document.createElement("div");
      row.className = "session" + (s.id === activeIdCache ? " active" : "");
      const top = document.createElement("div"); top.className = "row";
      const t = document.createElement("div"); t.className = "t"; t.textContent = s.title || "Untitled chat";
      const del = document.createElement("button"); del.className = "del"; del.textContent = "✕"; del.title = "Delete chat";
      top.appendChild(t); top.appendChild(del);
      const m = document.createElement("div"); m.className = "m"; m.textContent = s.when || "";
      row.appendChild(top); row.appendChild(m);
      row.onclick = () => vscode.postMessage({ type: "openSession", id: s.id });
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (del.classList.contains("confirm")) {
          vscode.postMessage({ type: "deleteSession", id: s.id });
        } else {
          del.classList.add("confirm");
          del.textContent = "Confirm?";
          setTimeout(() => { del.classList.remove("confirm"); del.textContent = "✕"; }, 2500);
        }
      };
      sessionsEl.appendChild(row);
    }
  }

  railSearch.addEventListener("input", () => renderSessions());

  function addMessage(role, text) {
    clearWelcome();
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const who = document.createElement("div");
    who.className = "who";
    const label = document.createElement("span");
    label.textContent = role === "user" ? "You" : "commons-crew";
    const copyBtn = document.createElement("button");
    copyBtn.className = "copyBtn"; copyBtn.textContent = "Copy"; copyBtn.title = "Copy message";
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied"; copyBtn.classList.add("copied");
        setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); }, 1200);
      });
    };
    who.appendChild(label); who.appendChild(copyBtn);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.appendChild(who); wrap.appendChild(bubble);
    transcript.appendChild(wrap);
    scroll();
  }

  const THINK_PREVIEW_LEN = 280;

  function addEvent(text, kind) {
    clearWelcome();
    statusEl = null;
    const el = document.createElement("div");
    el.className = "event" + (kind ? " " + kind : "");
    if (kind === "think" && text.length > THINK_PREVIEW_LEN) {
      const body = document.createElement("span");
      body.textContent = text.slice(0, THINK_PREVIEW_LEN) + "…";
      const more = document.createElement("span");
      more.className = "more"; more.textContent = "Show full reasoning";
      let expanded = false;
      more.onclick = () => {
        expanded = !expanded;
        body.textContent = expanded ? text : text.slice(0, THINK_PREVIEW_LEN) + "…";
        more.textContent = expanded ? "Show less" : "Show full reasoning";
        if (atBottom()) scroll();
      };
      el.appendChild(body); el.appendChild(more);
    } else {
      el.textContent = text;
    }
    transcript.appendChild(el);
    if (atBottom()) scroll();
  }

  function setStatus(text) {
    clearWelcome();
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = "status";
      transcript.appendChild(statusEl);
    }
    statusEl.textContent = text;
    if (atBottom()) scroll();
  }

  function addApproval(a) {
    clearWelcome();
    statusEl = null;
    const card = document.createElement("div");
    card.className = "approval";
    card.dataset.id = a.id;
    card.innerHTML =
      '<div class="title">Approve a governed side effect?</div>' +
      '<div class="detail"></div>' +
      '<div class="actions"></div>';
    card.querySelector(".detail").textContent = a.summary + (a.targetRef ? "  —  " + a.targetRef : "");
    const actions = card.querySelector(".actions");
    const approve = document.createElement("button"); approve.className = "primary"; approve.textContent = "Approve";
    const deny = document.createElement("button"); deny.className = "secondary"; deny.textContent = "Deny";
    approve.onclick = () => decide(card, a.id, "approved");
    deny.onclick = () => decide(card, a.id, "denied");
    actions.appendChild(approve); actions.appendChild(deny);
    transcript.appendChild(card);
    scroll();
  }

  function decide(card, id, decision) {
    card.classList.add("resolved");
    card.querySelector(".actions").innerHTML = "<em>" + (decision === "approved" ? "Approved" : "Denied") + "</em>";
    vscode.postMessage({ type: "approval", id: id, decision: decision });
  }

  function resolveApproval(id, decision) {
    const card = transcript.querySelector('.approval[data-id="' + id + '"]');
    if (card && !card.classList.contains("resolved")) {
      card.classList.add("resolved");
      card.querySelector(".actions").innerHTML = "<em>" + (decision === "approved" ? "Approved" : "Denied") + "</em>";
    }
  }

  function setBusy(v) {
    busy = v;
    send.disabled = v;
    send.textContent = v ? "Working…" : "Send";
  }

  function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    addMessage("user", text);
    sentHistory.push(text);
    historyIndex = -1; historyDraft = "";
    usageBar.textContent = "";
    input.value = ""; autosize();
    vscode.postMessage({ type: "send", text: text });
  }

  function recallHistory(direction) {
    if (sentHistory.length === 0) return false;
    if (direction < 0) {
      // Up: only start recalling from the top of the box, so mid-message
      // editing with multiple lines isn't hijacked.
      if (input.selectionStart !== 0 || input.selectionEnd !== 0) return false;
      if (historyIndex === -1) historyDraft = input.value;
      if (historyIndex < sentHistory.length - 1) historyIndex++;
    } else {
      if (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return false;
      if (historyIndex === -1) return false;
      historyIndex--;
    }
    input.value = historyIndex === -1 ? historyDraft : sentHistory[sentHistory.length - 1 - historyIndex];
    autosize();
    const pos = input.value.length;
    input.selectionStart = input.selectionEnd = pos;
    return true;
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function showConfig(reason) {
    clearWelcome();
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = reason === "no-api-key"
      ? "No inference key set. Add your API key in commons-crew settings (BYO — the runtime runs locally and calls your endpoint directly)."
      : reason === "no-workspace"
      ? "Open a folder first — the runtime acts inside your workspace."
      : reason;
    transcript.appendChild(box);
    if (reason === "no-api-key") {
      const cta = document.createElement("button");
      cta.className = "secondary"; cta.textContent = "Open Settings";
      cta.style.marginTop = "8px";
      cta.onclick = () => vscode.postMessage({ type: "openSettings" });
      transcript.appendChild(cta);
    }
    setBusy(false);
  }

  send.addEventListener("click", submit);
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === "ArrowUp") { if (recallHistory(-1)) e.preventDefault(); return; }
    if (e.key === "ArrowDown") { if (recallHistory(1)) e.preventDefault(); return; }
  });

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "sessions": renderSessions(m.sessions, m.activeId); break;
      case "reset":
        showWelcome(); statusEl = null; setBusy(false);
        sentHistory.length = 0; historyIndex = -1; historyDraft = "";
        usageBar.textContent = ""; stopBtn.hidden = true;
        break;
      case "hydrate":
        transcript.innerHTML = ""; statusEl = null; welcome = null;
        sentHistory.length = 0; historyIndex = -1; historyDraft = "";
        usageBar.textContent = ""; stopBtn.hidden = true;
        for (const msg of m.messages) {
          addMessage(msg.role, msg.text);
          if (msg.role === "user") sentHistory.push(msg.text);
        }
        setBusy(false);
        break;
      case "user": addMessage("user", m.text); break;
      case "assistant": statusEl = null; addMessage("assistant", m.text); break;
      case "status": setStatus(m.text); break;
      case "event": addEvent(m.text, m.kind); break;
      case "approval": addApproval(m); break;
      case "resolveApproval": resolveApproval(m.id, m.decision); break;
      case "error": clearWelcome(); statusEl = null; { const e = document.createElement("div"); e.className = "error"; e.textContent = m.text; transcript.appendChild(e); scroll(); } break;
      case "busy": setBusy(m.value); break;
      case "needsConfig": showConfig(m.reason); break;
      case "runActive": stopBtn.hidden = !m.value; break;
      case "usage": {
        const total = (m.promptTokens || 0) + (m.completionTokens || 0);
        const costPart = m.concurrencyCost != null ? " · concurrency cost " + m.concurrencyCost : "";
        usageBar.textContent = m.model
          ? m.model + " — " + total.toLocaleString() + " tokens (" + (m.promptTokens || 0).toLocaleString() + " in / " + (m.completionTokens || 0).toLocaleString() + " out)" + costPart
          : "";
        break;
      }
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
