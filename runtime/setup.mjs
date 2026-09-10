import React, { useState } from "react";

export function SetupForm({ title, fields, values = {}, submitTitle = "Continue", onSubmit }) {
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function submit(input) {
    const errors = Object.fromEntries(fields.filter(field => field.required && (input[field.name] === undefined || input[field.name] === "" || input[field.name] === null)).map(field => [field.name, "This field is required"]));
    setErrors(errors);
    if (Object.keys(errors).length || busy) return;
    setBusy(true);
    try { await onSubmit(input); } finally { setBusy(false); }
  }
  return React.createElement("Form", { navigationTitle: title, isLoading: busy },
    ...fields.map(field => {
      const value = values[field.name] ?? field.default ?? (field.type === "checkbox" ? false : "");
      const type = { checkbox: "Checkbox", dropdown: "Dropdown", password: "PasswordField", file: "FilePicker", directory: "FilePicker" }[field.type] || "TextField";
      return React.createElement(`Form.${type}`, {
        key: field.name, id: field.name, title: field.title || field.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase()), label: field.label,
        placeholder: field.placeholder || "", defaultValue: value, error: errors[field.name], info: field.description,
        canChooseDirectories: field.type === "directory", canChooseFiles: field.type === "file", allowMultipleSelection: false,
      }, ...(field.data || []).map(item => React.createElement("Form.Dropdown.Item", { key: item.value, value: item.value, title: item.title })));
    }),
    React.createElement("ActionPanel", {}, React.createElement("Action.SubmitForm", { title: busy ? "Working…" : submitTitle, onAction: submit })));
}
