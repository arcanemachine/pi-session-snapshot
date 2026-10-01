import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import snapshotExtension from "../src/index.js";
import {
  resetPermissionState,
  setConfiguration,
} from "../src/authorization.js";

const MODEL = {
  id: "script",
  name: "Script",
  api: "scripted-api",
  provider: "scripted",
  baseUrl: "http://127.0.0.1:1",
  input: ["text"],
  reasoning: false,
  contextWindow: 10_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

afterEach(() => resetPermissionState());

describe("live snapshot agent runtime", () => {
  it("runs the full save, prompted restore, and no-prompt restore sequence", async () => {
    const result = await runScriptedRuntime("chain");
    expect(result.calls).toBe(3);
    expect(result.freshPrompt).toEqual([
      { type: "text", text: "/continue from snapshot" },
    ]);
    expect(result.snapshotHasRestoreToolCall).toBe(false);
    expect(result.finalCustomEntry).toMatchObject({
      customType: "pi-session-snapshot:restore",
      data: { name: "snapshot-tool-test" },
    });
    expect(result.providerSawCustomMessage).toBe(false);
    expect(result.providerSawRestoreNotice).toBe(false);
    expect(result.currentSessionFile).not.toBe(result.initialSessionFile);
    expect(result.replacements).toBe(3);
    expect(result.snapshotUnchanged).toBe(true);
    expect(result.finalSessionRemovedAfterDispose).toBe(true);
  }, 15_000);

  it("stops a same-assistant save and restore batch before another provider request", async () => {
    const result = await runScriptedRuntime("same-batch");
    expect(result.calls).toBe(2);
    expect(result.freshPrompt).toEqual([
      { type: "text", text: "/continue from snapshot" },
    ]);
    expect(result.snapshotHasRestoreToolCall).toBe(false);
    expect(result.providerSawCustomMessage).toBe(false);
    expect(result.providerSawRestoreNotice).toBe(false);
    expect(result.replacements).toBe(2);
    expect(result.snapshotUnchanged).toBe(true);
  }, 15_000);

  it("preserves mixed-batch results while switching immediately", async () => {
    const result = await runScriptedRuntime("mixed-batch");
    expect(result.calls).toBe(2);
    expect(result.freshPrompt).toEqual([
      { type: "text", text: "/continue from snapshot" },
    ]);
    expect(result.snapshotHasRestoreToolCall).toBe(false);
    expect(result.providerSawCustomMessage).toBe(false);
    expect(result.providerSawRestoreNotice).toBe(false);
    expect(result.replacements).toBe(3);
    expect(result.snapshotUnchanged).toBe(true);
  }, 15_000);
});

type Scenario = "chain" | "same-batch" | "mixed-batch";

async function runScriptedRuntime(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-snapshot-live-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-session-snapshot": {
        agentSaveToolAllowed: true,
        agentRestoreToolAllowed: true,
      },
    }),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  setConfiguration({ save: true, restore: true });

  let phase: "save" | "restorePrompt" | "fresh" | "done" = "save";
  let calls = 0;
  let freshPrompt: unknown;
  let providerSawCustomMessage = false;
  let providerSawRestoreNotice = false;
  let replacements = 0;
  let snapshotAtFirstReplacement: string | undefined;
  const provider = (pi: any) =>
    pi.registerProvider("scripted", {
      name: "Scripted",
      baseUrl: "http://127.0.0.1:1",
      api: "scripted-api",
      apiKey: "dummy",
      models: [MODEL],
      streamSimple(model: any, context: any) {
        calls += 1;
        providerSawCustomMessage ||= context.messages.some(
          (message: any) => message.role === "custom",
        );
        providerSawRestoreNotice ||= context.messages.some((message: any) =>
          JSON.stringify(message).includes("Restored session snapshot"),
        );
        const users = context.messages.filter(
          (message: any) => message.role === "user",
        );
        if (phase === "fresh") freshPrompt = users.at(-1)?.content;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
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
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          if (
            (scenario === "same-batch" || scenario === "mixed-batch") &&
            phase === "save"
          ) {
            const saveCall: any = {
              type: "toolCall",
              id: "save-call",
              name: "snapshot_save",
              arguments: { name: "snapshot-tool-test" },
            };
            const restoreCall: any = {
              type: "toolCall",
              id: "restore-call",
              name: "snapshot_restore",
              arguments: {
                name: "snapshot-tool-test",
                prompt: "/continue from snapshot",
              },
            };
            const calls =
              scenario === "mixed-batch"
                ? [
                    {
                      type: "toolCall",
                      id: "before",
                      name: "harmless",
                      arguments: {},
                    },
                    saveCall,
                    restoreCall,
                    {
                      type: "toolCall",
                      id: "after",
                      name: "harmless",
                      arguments: {},
                    },
                  ]
                : [saveCall, restoreCall];
            pushToolBatch(stream, message, calls);
            phase = "fresh";
          } else if (scenario === "chain" && phase === "save") {
            pushToolCall(stream, message, {
              type: "toolCall",
              id: "save-call",
              name: "snapshot_save",
              arguments: { name: "snapshot-tool-test" },
            });
            phase = "restorePrompt";
          } else if (scenario === "chain" && phase === "restorePrompt") {
            pushToolCall(stream, message, {
              type: "toolCall",
              id: "restore-call-1",
              name: "snapshot_restore",
              arguments: {
                name: "snapshot-tool-test",
                prompt: "/continue from snapshot",
              },
            });
            phase = "fresh";
          } else if (
            (scenario === "chain" || scenario === "mixed-batch") &&
            phase === "fresh"
          ) {
            pushToolCall(stream, message, {
              type: "toolCall",
              id: "restore-call-2",
              name: "snapshot_restore",
              arguments: { name: "snapshot-tool-test" },
            });
            phase = "done";
          } else {
            message.stopReason = "stop";
            const text: any = { type: "text", text: "continued" };
            message.content.push(text);
            stream.push({ type: "start", partial: message });
            stream.push({
              type: "text_start",
              contentIndex: 0,
              partial: message,
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: text.text,
              partial: message,
            });
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
        });
        return stream;
      },
    });

  const runtime = await createAgentSessionRuntime(
    async ({ sessionManager }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          extensionFactories: [provider, snapshotExtension],
          noExtensions: true,
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: MODEL as any,
        tools:
          scenario === "mixed-batch"
            ? ["snapshot_save", "snapshot_restore", "harmless"]
            : ["snapshot_save", "snapshot_restore"],
        customTools:
          scenario === "mixed-batch"
            ? [
                {
                  name: "harmless",
                  label: "Harmless",
                  description: "A harmless test tool.",
                  parameters: Type.Object({}),
                  async execute() {
                    return {
                      content: [{ type: "text", text: "ok" }],
                      details: {},
                    };
                  },
                },
              ]
            : undefined,
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.create(cwd) },
  );
  const initialSessionFile = runtime.session.sessionManager.getSessionFile();
  const snapshotFile = join(
    agentDir,
    "pi-session-snapshot",
    "snapshot-tool-test.jsonl",
  );
  const bindSession = async (session: any) => {
    replacements += 1;
    if (replacements > 1 && !snapshotAtFirstReplacement) {
      snapshotAtFirstReplacement = await readFile(snapshotFile, "utf8");
    }
    await session.bindExtensions({
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        switchSession: (path: string, options: any) =>
          runtime.switchSession(path, options),
        newSession: (options: any) => runtime.newSession(options),
        fork: (entryId: string, options: any) => runtime.fork(entryId, options),
      },
    });
  };
  runtime.setRebindSession(bindSession);
  await bindSession(runtime.session);

  let result: any;
  let currentSessionFile = "";
  try {
    await runtime.session.prompt("create and restore snapshot");
    await new Promise((resolve) => setTimeout(resolve, 300));
    currentSessionFile = runtime.session.sessionManager.getSessionFile()!;
    const snapshotText = await readFile(snapshotFile, "utf8");
    const finalEntries = SessionManager.open(currentSessionFile).getEntries();
    result = {
      calls,
      freshPrompt,
      providerSawCustomMessage,
      providerSawRestoreNotice,
      replacements,
      snapshotUnchanged:
        snapshotAtFirstReplacement !== undefined &&
        snapshotAtFirstReplacement === snapshotText,
      initialSessionFile,
      currentSessionFile,
      snapshotHasRestoreToolCall: /"toolCall".*"name":"snapshot_restore"/.test(
        snapshotText,
      ),
      finalCustomEntry: finalEntries.find(
        (entry: any) => entry.type === "custom",
      ),
      finalSessionRemovedAfterDispose: false,
    };
  } finally {
    await runtime.dispose();
    if (currentSessionFile) {
      result.finalSessionRemovedAfterDispose =
        !(await fileExists(currentSessionFile));
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
  return result;
}

function pushToolBatch(
  stream: any,
  message: AssistantMessage,
  toolCalls: any[],
) {
  message.content.push(...toolCalls);
  stream.push({ type: "start", partial: message });
  toolCalls.forEach((toolCall, contentIndex) => {
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: message,
    });
  });
  stream.push({ type: "done", reason: "toolUse", message });
}

function pushToolCall(stream: any, message: AssistantMessage, toolCall: any) {
  message.content.push(toolCall);
  stream.push({ type: "start", partial: message });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  stream.push({ type: "done", reason: "toolUse", message });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
