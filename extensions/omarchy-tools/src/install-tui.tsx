import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, confirmReplacement, run } from "./components";
import { tuiArguments, desktopPath } from "./workflows.ts";

export default function InstallTUI() {
  const workflow = useWorkflow();
  return <Form navigationTitle="Install TUI" isLoading={workflow.busy} actions={<WorkflowActions title="Install" workflow={workflow}
    onSubmit={values => workflow.submit("TUI installed", async signal => {
      const args = tuiArguments(values);
      if (!await confirmReplacement(desktopPath(args[0]), args[0])) return false;
      await run("omarchy-tui-install", args, { signal });
    })} />}>
    <Form.TextField id="name" title="Name" placeholder="My terminal app" error={workflow.errors.name} />
    <Form.TextField id="command" title="Command" placeholder="lazydocker" error={workflow.errors.command} />
    <Form.Dropdown id="style" title="Window" defaultValue="float" error={workflow.errors.style}>
      <Form.Dropdown.Item value="float" title="Floating" />
      <Form.Dropdown.Item value="tile" title="Tiled" />
    </Form.Dropdown>
    <Form.TextField id="icon" title="Icon" placeholder="utilities-terminal" error={workflow.errors.icon} />
  </Form>;
}
