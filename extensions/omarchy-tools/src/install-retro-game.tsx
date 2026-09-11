import { useEffect, useState } from "react";
import { Form, Toast, showToast } from "@raycast/api";
import { useWorkflow, WorkflowActions, FileField, run } from "./components";
import { errorMessage, retroCores, retroGameArguments } from "./workflows.ts";

export default function InstallRetroGame() {
  const workflow = useWorkflow();
  const [cores, setCores] = useState<{ title: string, id: string }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    run("omarchy-games-retro-cores", [], { signal: controller.signal }).then(output => { if (!controller.signal.aborted) setCores(retroCores(output)); })
      .catch(error => { if (!controller.signal.aborted) showToast({ style: Toast.Style.Failure, title: "Could not load cores", message: errorMessage(error) }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
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
