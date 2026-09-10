import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, FileField } from "./components";
import { installWallpapers } from "./workflows.mjs";

export default function InstallWallpaper() {
  const workflow = useWorkflow();
  return <Form navigationTitle="Install Wallpaper" isLoading={workflow.busy} actions={<WorkflowActions title="Install" workflow={workflow}
    onSubmit={values => workflow.submit("Wallpaper installed", signal => installWallpapers(values, { signal }))} />}>
    <FileField errors={workflow.errors} title="Images" multiple />
    <Form.Checkbox id="apply" label="Set as background" defaultValue={true} />
  </Form>;
}
