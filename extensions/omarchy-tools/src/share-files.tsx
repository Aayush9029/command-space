import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, FileField, run } from "./components";
import { selectedPaths } from "./workflows.ts";

export function Share({ directory = false }) {
  const workflow = useWorkflow();
  return <Form navigationTitle={directory ? "Share Folder" : "Share Files"} isLoading={workflow.busy}
    actions={<WorkflowActions title="Share" workflow={workflow} onSubmit={values => workflow.submit("Opened LocalSend", async signal => {
      const files = await selectedPaths(values.files, { directory, multiple: !directory });
      await run("omarchy-menu-share", [directory ? "folder" : "file", ...files], { signal });
    })} />}>
    <FileField errors={workflow.errors} multiple={!directory} directory={directory} />
  </Form>;
}

export default function ShareFiles() { return <Share />; }
