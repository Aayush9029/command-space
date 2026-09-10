import { useState } from "react";
import { Form, confirmAlert } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { addShellPlugin, plainText } from "./workflows.mjs";

export default function AddShellPlugin() {
  const workflow = useWorkflow();
  const [enable, setEnable] = useState(true);
  return <Form navigationTitle="Add Shell Plugin" isLoading={workflow.busy} actions={<WorkflowActions title="Add Plugin" workflow={workflow}
    onSubmit={values => workflow.submit("Plugin added", async signal => {
      const repository = plainText(values.repository, "repository", "Repository");
      if (!await confirmAlert({ title: "Add this shell plugin?", message: `${repository}\n\nShell plugins run code inside Omarchy. Only add repositories you trust.`, primaryAction: { title: "Add Plugin" } })) return false;
      await addShellPlugin(values, { signal });
    })} />}>
    <Form.TextField id="repository" title="Repository" placeholder="https://github.com/owner/omarchy-plugin" error={workflow.errors.repository} />
    <Form.Checkbox id="enable" label="Enable after adding" value={enable} onChange={setEnable} />
    {enable && <Form.Dropdown id="section" title="Bar Position" defaultValue="default" error={workflow.errors.section}>
      <Form.Dropdown.Item value="default" title="Plugin Default" />
      <Form.Dropdown.Item value="left" title="Left" />
      <Form.Dropdown.Item value="center" title="Center" />
      <Form.Dropdown.Item value="right" title="Right" />
    </Form.Dropdown>}
  </Form>;
}
