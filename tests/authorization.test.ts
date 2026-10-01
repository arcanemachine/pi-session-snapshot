import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatPermissionStatus,
  refreshConfiguration,
  resetPermissionState,
  resolveConfiguration,
  resolvePermission,
  setOverride,
} from "../src/authorization.js";

afterEach(() => resetPermissionState());

describe("resolveConfiguration", () => {
  it("denies both capabilities by default", () => {
    expect(resolveConfiguration({}, {}, false)).toEqual({
      save: false,
      restore: false,
    });
  });

  it("uses global settings and trusted project overrides", () => {
    expect(
      resolveConfiguration(
        {
          "pi-session-snapshot": {
            agentSaveToolAllowed: true,
            agentRestoreToolAllowed: false,
          },
        },
        {
          "pi-session-snapshot": {
            agentRestoreToolAllowed: true,
          },
        },
        true,
      ),
    ).toEqual({ save: true, restore: true });
  });

  it("inherits omitted project fields and ignores untrusted project settings", () => {
    const global = {
      "pi-session-snapshot": { agentSaveToolAllowed: true },
    };
    const project = {
      "pi-session-snapshot": { agentSaveToolAllowed: false },
    };
    expect(resolveConfiguration(global, project, true)).toEqual({
      save: false,
      restore: false,
    });
    expect(resolveConfiguration(global, project, false)).toEqual({
      save: true,
      restore: false,
    });
  });

  it("fails closed for malformed values", () => {
    const warnings: string[] = [];
    expect(
      resolveConfiguration(
        {
          "pi-session-snapshot": {
            agentSaveToolAllowed: "yes",
            agentRestoreToolAllowed: true,
          },
        },
        {},
        false,
        warnings,
      ),
    ).toEqual({ save: false, restore: true });
    expect(warnings.join("\n")).toContain("agentSaveToolAllowed");
  });
});

describe("refreshConfiguration", () => {
  it("fails closed and warns when global settings cannot be parsed", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(
      join(tmpdir(), "pi-session-snapshot-settings-"),
    );
    await writeFile(join(agentDir, "settings.json"), "{");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const notifications: string[] = [];
    try {
      expect(
        refreshConfiguration({
          cwd: agentDir,
          isProjectTrusted: () => false,
          ui: {
            notify(message: string) {
              notifications.push(message);
            },
          } as never,
        }),
      ).toEqual({ save: false, restore: false });
      expect(notifications.join("\n")).toContain(
        "could not read global settings",
      );
    } finally {
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

describe("process-local permission overrides", () => {
  it("takes precedence and reset returns to the denied baseline", () => {
    expect(resolvePermission("save")).toEqual({
      allowed: false,
      source: "default",
    });
    setOverride("save", true);
    expect(resolvePermission("save")).toEqual({
      allowed: true,
      source: "override",
    });
    setOverride("save", null);
    expect(resolvePermission("save")).toEqual({
      allowed: false,
      source: "default",
    });
  });

  it("formats the effective status", () => {
    setOverride("restore", true);
    expect(formatPermissionStatus("restore")).toContain(
      "restore: allowed (override",
    );
  });
});
