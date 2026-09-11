import { isRecord, type ValueRecord } from "./types.ts";
import type { SetupField } from "./setup.ts";

export interface ExtensionCommand {
  name: string;
  title: string;
  mode: string;
  path?: string;
  preferences: SetupField[];
  arguments: SetupField[];
}

export interface ExtensionManifest {
  name: string;
  title: string;
  owner?: string;
  author?: string;
  commands: ExtensionCommand[];
  preferences: SetupField[];
}

function text(value: ValueRecord, key: string, required = false): string | undefined {
  const item = value[key];
  if (item === undefined && !required) return undefined;
  if (typeof item !== "string" || (required && !item)) throw new Error(`Invalid extension manifest ${key}`);
  return item;
}

function named(value: unknown, context: string): ValueRecord & { name: string } {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) throw new Error(`Invalid extension ${context} name`);
  return { ...value, name: value.name };
}

function fields(value: unknown): SetupField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Extension fields must be an array");
  return value.map((item: unknown) => {
    const field = named(item, "field");
    if (field.required !== undefined && typeof field.required !== "boolean") throw new Error("Invalid extension field required flag");
    let data: SetupField["data"];
    if (field.data !== undefined) {
      if (!Array.isArray(field.data)) throw new Error("Extension field choices must be an array");
      data = field.data.map((item: unknown) => {
        if (!isRecord(item) || typeof item.value !== "string" || typeof item.title !== "string") throw new Error("Invalid extension field choice");
        return { value: item.value, title: item.title };
      });
    }
    return { name: field.name, type: text(field, "type") ?? "textfield", title: text(field, "title"), label: text(field, "label"), placeholder: text(field, "placeholder"), description: text(field, "description"), required: field.required, default: field.default, data };
  });
}

export function extensionManifest(value: unknown): ExtensionManifest {
  const manifest = named(value, "manifest");
  if (!Array.isArray(manifest.commands)) throw new Error("Extension commands must be an array");
  const commands = manifest.commands.map((item: unknown): ExtensionCommand => {
    const command = named(item, "command");
    return { name: command.name, title: text(command, "title") ?? command.name, mode: text(command, "mode") ?? "view", path: text(command, "path"), preferences: fields(command.preferences), arguments: fields(command.arguments) };
  });
  return { name: manifest.name, title: text(manifest, "title") ?? manifest.name, owner: text(manifest, "owner"), author: text(manifest, "author"), preferences: fields(manifest.preferences), commands };
}
