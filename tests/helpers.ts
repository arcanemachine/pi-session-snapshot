import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const tempDirectories: string[] = [];

export function makeTempDirectory(prefix = "pi-session-snapshot-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

export function cleanupTempDirectories(): void {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function makeSessionDirectories(): {
  root: string;
  cwd: string;
  sessions: string;
  agent: string;
} {
  const root = makeTempDirectory();
  const cwd = join(root, "project");
  const sessions = join(root, "sessions");
  const agent = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(agent, { recursive: true });
  return { root, cwd, sessions, agent };
}

export function appendUser(session: SessionManager, text: string): string {
  return session.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

export function appendAssistant(session: SessionManager, text: string): string {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return session.appendMessage(message);
}

export function messageText(entry: { message?: unknown }): string | undefined {
  const message = entry.message as
    | { content?: string | Array<{ type?: string; text?: string }> }
    | undefined;
  if (typeof message?.content === "string") return message.content;
  return message?.content?.find((part) => part.type === "text")?.text;
}
