import { useEffect, useState } from "react";
import { Form, Toast, showToast } from "@raycast/api";
import { useWorkflow, WorkflowActions, FileField, run } from "./components";
import { retroCores, retroGameArguments } from "./workflows.mjs";

export default function InstallRetroGame() {
  const workflow = useWorkflow();
  const [cores, setCores] = useState<{ title: string, id: string }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    run("omarchy-games-retro-cores", [], { signal: controller.signal }).then(output => setCores(retroCores(output)))
      .catch(error => { if (!controller.signal.aborted) showToast({ style: Toast.Style.Failure, title: "Could not load cores", message: error.message }); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);
  return <Form navigationTitle="Install Retro Game" isLoading={loading || workflow.busy} actions={<WorkflowActions title="Install" workflow={workflow}
    onSubmit={values => workflow.submit("Game installed", async signal => {
      const args = await retroGameArguments(values, run, signal);
      await run("omarchy-games-retro-install", args, { signal });
    })} />}>
    <Form.Dropdown id="core" title="Core" error={workflow.errors.core || (!loading && !cores.length ? "Install RetroArch cores first" : undefined)}>
      {cores.map(core => <Form.Dropdown.Item key={core.id} value={core.id} title={core.title} />)}
    </Form.Dropdown>
    <FileField errors={workflow.errors} title="Game ROM" />
  </Form>;
}
