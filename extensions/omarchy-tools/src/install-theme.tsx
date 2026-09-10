import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { installTheme } from "./workflows.mjs";

export default function InstallTheme() {
  const workflow = useWorkflow();
  return <Form navigationTitle="Install Theme" isLoading={workflow.busy} actions={<WorkflowActions title="Install & Apply" workflow={workflow}
    onSubmit={values => workflow.submit("Theme installed", signal => installTheme(values, { signal }))} />}>
    <Form.TextField id="repository" title="Repository" placeholder="https://github.com/owner/omarchy-example-theme" error={workflow.errors.repository} />
  </Form>;
}
