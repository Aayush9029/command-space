import React, { useRef, useState } from "react";
import { isRecord, type ValueRecord } from "./types.ts";

export interface SetupField {
  name: string;
  type: string;
  title?: string;
  label?: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  data?: { value: string; title: string }[];
}

export interface SetupFormProps {
  title: string;
  fields: SetupField[];
  values?: ValueRecord;
  submitTitle?: string;
  onSubmit(values: ValueRecord): void | Promise<void>;
}

const fieldTypes: Record<string, string> = { checkbox: "Checkbox", dropdown: "Dropdown", password: "PasswordField", file: "FilePicker", directory: "FilePicker" };

export function SetupForm({ title, fields, values = {}, submitTitle = "Continue", onSubmit }: SetupFormProps): React.ReactElement {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  async function submit(input: unknown): Promise<void> {
    if (!isRecord(input)) throw new Error("Form submission must contain field values");
    const errors = Object.fromEntries(fields.filter(field => field.required && (input[field.name] === undefined || input[field.name] === "" || input[field.name] === null)).map(field => [field.name, "This field is required"]));
    setErrors(errors);
    if (Object.keys(errors).length || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try { await onSubmit(input); } finally { submitting.current = false; setBusy(false); }
  }
  return React.createElement("Form", { navigationTitle: title, isLoading: busy },
    ...fields.map(field => {
      const value = values[field.name] ?? field.default ?? (field.type === "checkbox" ? false : "");
      const type = fieldTypes[field.type] || "TextField";
      return React.createElement(`Form.${type}`, {
        key: field.name, id: field.name, title: field.title || field.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase()), label: field.label,
        placeholder: field.placeholder || "", defaultValue: value, error: errors[field.name], info: field.description,
        canChooseDirectories: field.type === "directory", canChooseFiles: field.type === "file", allowMultipleSelection: false,
      }, ...(field.data || []).map(item => React.createElement("Form.Dropdown.Item", { key: item.value, value: item.value, title: item.title })));
    }),
    React.createElement("ActionPanel", {}, React.createElement("Action.SubmitForm", { title: busy ? "Working…" : submitTitle, onAction: submit })));
}
