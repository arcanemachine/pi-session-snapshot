import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
} from "@earendil-works/pi-tui";
import type {
  ActionKind,
  ActionMenuResult,
  CollisionChoice,
  PickedSnapshot,
  SnapshotUI,
} from "./flow.js";
import type { SnapshotEntry } from "../snapshots.js";

const END_KEY = "\x1bOF"; // cursorLineEnd, matches the sibling rename pattern

function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

const ACTION_ITEMS: { value: ActionKind; label: string }[] = [
  { value: "save", label: "Save snapshot" },
  { value: "load", label: "Load snapshot" },
  { value: "delete", label: "Delete snapshot" },
  { value: "list", label: "List snapshots" },
];

export function createSnapshotUI(ctx: ExtensionCommandContext): SnapshotUI {
  return {
    async selectAction(initialIndex: number): Promise<ActionMenuResult> {
      const items: SelectItem[] = ACTION_ITEMS.map((item) => ({
        value: item.value,
        label: item.label,
      }));
      const value = await selectSingle<ActionKind>(
        ctx,
        "Session snapshots",
        items,
        "back",
        initialIndex,
      );
      if (value === null) return { kind: "cancel", index: initialIndex };
      const index = Math.max(
        ACTION_ITEMS.findIndex((item) => item.value === value),
        0,
      );
      return { kind: value, index };
    },

    async inputName(title, initial, placeholder): Promise<string | null> {
      return showTextInput(ctx, title, initial, placeholder);
    },

    async pickSnapshot(
      title,
      items,
      initialIndex,
    ): Promise<PickedSnapshot | null> {
      const selectItems: SelectItem[] = items.map((item) => ({
        value: item.name,
        label: `${item.name}  ${formatBytes(item.bytes)}`,
      }));
      const value = await selectSingle<string>(
        ctx,
        title,
        selectItems,
        "back",
        initialIndex,
      );
      if (value === null) return null;
      const index = Math.max(
        items.findIndex((item) => item.name === value),
        0,
      );
      return { entry: items[index]!, index };
    },

    async confirmReplacement(name): Promise<CollisionChoice> {
      const items: SelectItem[] = [
        { value: "cancel", label: "Cancel" },
        { value: "replace", label: "Replace" },
        { value: "rename", label: "Save as another name" },
      ];
      const value = await selectSingle<string>(
        ctx,
        `Snapshot "${name}" already exists`,
        items,
        "cancel",
        0,
      );
      if (value === null) return "cancel";
      return value as CollisionChoice;
    },

    async confirmDelete(name): Promise<boolean> {
      return showNoDefaultConfirm(
        ctx,
        "Delete session snapshot",
        `Permanently delete the snapshot "${name}"?`,
      );
    },

    notify(message, type) {
      ctx.ui.notify(message, type);
    },

    async showList(items): Promise<void> {
      if (items.length === 0) {
        ctx.ui.notify("No session snapshots are saved yet.", "info");
        return;
      }
      const selectItems: SelectItem[] = items.map((item) => ({
        value: item.name,
        label: `${item.name}  ${formatBytes(item.bytes)}`,
      }));
      await selectSingle<string>(
        ctx,
        "Session snapshots",
        selectItems,
        "back",
        0,
      );
    },
  };
}

function selectSingle<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  cancelLabel: string,
  initialIndex: number,
): Promise<T | null> {
  return ctx.ui.custom<T | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(new Text(theme.bold(title), 1, 0));
    const list = new SelectList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      selectTheme(theme),
    );
    list.setSelectedIndex(initialIndex);
    list.onSelect = (item) => done(item.value as T);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(
      new Text(
        theme.fg("dim", `↑↓ navigate • enter select • esc ${cancelLabel}`),
        1,
        0,
      ),
    );
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function showTextInput(
  ctx: ExtensionCommandContext,
  title: string,
  initial: string,
  placeholder?: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const input = new Input();
    input.setValue(initial);
    input.focused = true;
    // Pre-filling leaves the caret at the start; move it to the end so
    // re-entry from collision handling appends rather than prepends.
    if (initial.length > 0) input.handleInput(END_KEY);
    input.onSubmit = (value) => done(value);
    input.onEscape = () => done(null);

    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(new Text(theme.bold(title), 1, 0));
    if (placeholder)
      container.addChild(new Text(theme.fg("dim", placeholder), 0, 0));
    container.addChild(input);
    container.addChild(
      new Text(theme.fg("dim", "enter confirm • esc back"), 1, 0),
    );
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        input.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function showNoDefaultConfirm(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
    const items: SelectItem[] = [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ];
    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(new Text(theme.bold(title), 1, 0));
    container.addChild(new Text(theme.fg("muted", message), 1, 0));
    const list = new SelectList(items, 2, selectTheme(theme));
    list.setSelectedIndex(1); // No is the safe default
    list.onSelect = (item) => done(item.value === "yes");
    list.onCancel = () => done(false);
    container.addChild(list);
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
        1,
        0,
      ),
    );
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}
