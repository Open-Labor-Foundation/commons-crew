import * as vscode from "vscode";
import { RuntimeHost } from "./runtime-host";
import { ChatViewProvider } from "./chat-view";

// commons-crew as a first-class VS Code plugin: its own activity-bar container
// with a single webview that puts the session-history rail and the chat side by
// side. The engine is the real commons-crew runtime, embedded in-process (BYO
// key, local json store, live catalog) — the extension is only its VS Code surface.

export function activate(context: vscode.ExtensionContext): void {
  const host = new RuntimeHost(context);
  const chat = new ChatViewProvider(context, host);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("commonsCrew.main", chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("commonsCrew.newChat", () => chat.newChat()),
    vscode.commands.registerCommand("commonsCrew.refreshHistory", () => void chat.refreshSessions()),
    vscode.commands.registerCommand("commonsCrew.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "commonsCrew")
    ),
    vscode.commands.registerCommand("commonsCrew.openSession", (sessionId: string) => void chat.openSession(sessionId)),
    { dispose: () => void host.dispose() }
  );
}

export function deactivate(): void {
  // RuntimeHost is disposed via the subscription above.
}
