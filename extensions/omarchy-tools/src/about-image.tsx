import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, FileField, run } from "./components";
import { brandingArguments } from "./workflows.ts";

export function BrandingImage({ target = "about" }) {
  const workflow = useWorkflow();
  return <Form navigationTitle={target === "about" ? "Set About Image" : "Set Screensaver Image"} isLoading={workflow.busy}
    actions={<WorkflowActions title="Set Image" workflow={workflow} onSubmit={values => workflow.submit("Image updated", async signal => {
      await run("omarchy-transcode-ascii", await brandingArguments(values, target), { signal });
    })} />}>
    <FileField errors={workflow.errors} title="PNG or SVG" />
  </Form>;
}

export default function AboutImage() { return <BrandingImage />; }
