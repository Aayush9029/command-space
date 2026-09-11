import { errorMessage } from "./workflows.ts";
import { useEffect, useState } from "react";
import { Form, WindowManagement } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { moveBounds, resizeBounds } from "./window-bounds.ts";

type Target = Awaited<ReturnType<typeof WindowManagement.getActiveWindow>>;

export function WindowForm({ operation }: { operation: "move" | "resize" }) {
  const workflow = useWorkflow();
  const [target, setTarget] = useState<Target | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const moving = operation === "move";
  const title = moving ? "Move Window" : "Resize Window";
  const fields = moving ? [["x", "X"], ["y", "Y"]] : [["width", "Width"], ["height", "Height"]];
  useEffect(() => {
    let mounted = true;
    WindowManagement.getActiveWindow().then(window => {
      if (!mounted) return;
      setTarget(window);
      if (window.bounds !== "fullscreen") {
        setValues(Object.fromEntries(Object.entries({ ...window.bounds.position, ...window.bounds.size }).map(([key, value]) => [key, String(value)])));
      }
    }).catch(error => { if (mounted) setError(errorMessage(error)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  return <Form navigationTitle={title} isLoading={loading || workflow.busy}
    actions={<WorkflowActions title={moving ? "Move" : "Resize"} workflow={workflow} onSubmit={submitted => workflow.submit(moving ? "Window moved" : "Window resized", async signal => {
      if (!target) throw new Error(error || "The active window is still loading");
      const bounds = moving ? moveBounds(submitted) : resizeBounds(submitted);
      signal.throwIfAborted();
      await WindowManagement.setWindowBounds({ id: target.id, bounds });
    })} />}>
    <Form.Description title="Window" text={target?.title || target?.application.name || error || "Loading…"} />
    {!loading && fields.map(([id, label]) => <Form.TextField key={id} id={id} title={label} placeholder="Pixels"
      value={values[id] ?? ""} onChange={value => setValues(current => ({ ...current, [id]: value }))} error={workflow.errors[id]} />)}
  </Form>;
}
