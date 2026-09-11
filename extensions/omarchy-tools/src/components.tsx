import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Action, ActionPanel, Form, Toast, showToast, confirmAlert, closeMainWindow } from "@raycast/api";
import { FieldError, errorMessage, run, pathExists, type WorkflowValues } from "./workflows.ts";

export function useWorkflow() {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  async function submit(title: string, work: (signal: AbortSignal) => Promise<unknown>) {
    if (active.current) return false;
    const controller = new AbortController();
    active.current = controller;
    setErrors({});
    setBusy(true);
    try {
      const result = await work(controller.signal);
      if (result === false || controller.signal.aborted) return false;
      await showToast({ style: Toast.Style.Success, title });
      await closeMainWindow();
      return true;
    } catch (error) {
      if (error instanceof FieldError) setErrors({ [error.field]: error.message });
      if (!controller.signal.aborted) await showToast({ style: Toast.Style.Failure, title: "Could not complete", message: errorMessage(error) });
      return false;
    } finally {
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, errors, submit, cancel: () => active.current?.abort() };
}

interface WorkflowActionsProps {
  title: string;
  workflow: ReturnType<typeof useWorkflow>;
  onSubmit: (values: WorkflowValues) => Promise<unknown>;
}

export function WorkflowActions({ title, workflow, onSubmit }: WorkflowActionsProps) {
  return <ActionPanel>
    {workflow.busy
      ? <Action title="Cancel" onAction={workflow.cancel} />
      : <Action.SubmitForm title={title} onSubmit={onSubmit} />}
  </ActionPanel>;
}

type FileFieldProps = Omit<ComponentProps<typeof Form.FilePicker>, "id"> & {
  errors: Record<string, string | undefined>;
  multiple?: boolean;
  directory?: boolean;
};

export function FileField({ errors, multiple = false, directory = false, ...props }: FileFieldProps) {
  return <Form.FilePicker id="files" title={directory ? "Folder" : multiple ? "Files" : "File"}
    allowMultipleSelection={multiple} canChooseFiles={!directory} canChooseDirectories={directory}
    error={errors.files} {...props} />;
}

export async function confirmReplacement(file: string, name: string) {
  return !await pathExists(file) || await confirmAlert({ title: `Replace ${name}?`, message: "A desktop launcher with this name already exists.", primaryAction: { title: "Replace", style: Action.Style.Destructive } });
}

export { run };
