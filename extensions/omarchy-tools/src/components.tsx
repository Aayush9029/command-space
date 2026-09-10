import { useEffect, useRef, useState } from "react";
import { Action, ActionPanel, Form, Toast, showToast, confirmAlert, closeMainWindow } from "@raycast/api";
import { FieldError, run, pathExists } from "./workflows.mjs";

export function useWorkflow() {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function submit(title: string, work: (signal: AbortSignal) => Promise<unknown>) {
    if (active.current) return false;
    const controller = new AbortController();
    active.current = controller;
    setErrors({});
    setBusy(true);
    try {
      const result = await work(controller.signal);
      if (result === false) return false;
      await showToast({ style: Toast.Style.Success, title });
      await closeMainWindow();
      return true;
    } catch (error) {
      if (error instanceof FieldError) setErrors({ [error.field]: error.message });
      if (!controller.signal.aborted) await showToast({ style: Toast.Style.Failure, title: "Could not complete", message: error.message });
      return false;
    } finally {
      active.current = null;
      setBusy(false);
    }
  }
  return { busy, errors, submit, cancel: () => active.current?.abort() };
}

export function WorkflowActions({ title, workflow, onSubmit }) {
  return <ActionPanel>
    {workflow.busy
      ? <Action title="Cancel" onAction={workflow.cancel} />
      : <Action.SubmitForm title={title} onSubmit={onSubmit} />}
  </ActionPanel>;
}

export function FileField({ errors, multiple = false, directory = false, ...props }) {
  return <Form.FilePicker id="files" title={directory ? "Folder" : multiple ? "Files" : "File"}
    allowMultipleSelection={multiple} canChooseFiles={!directory} canChooseDirectories={directory}
    error={errors.files} {...props} />;
}

export async function confirmReplacement(file: string, name: string) {
  return !await pathExists(file) || await confirmAlert({ title: `Replace ${name}?`, message: "A desktop launcher with this name already exists.", primaryAction: { title: "Replace", style: Action.Style.Destructive } });
}

export { run };
