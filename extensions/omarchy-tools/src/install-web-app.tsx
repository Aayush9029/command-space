import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, confirmReplacement, run } from "./components";
import { webAppArguments, desktopPath } from "./workflows.mjs";

export default function InstallWebApp() {
  const workflow = useWorkflow();
  return <Form navigationTitle="Install Web App" isLoading={workflow.busy} actions={<WorkflowActions title="Install" workflow={workflow}
    onSubmit={values => workflow.submit("Web app installed", async signal => {
      const args = webAppArguments(values);
      if (!await confirmReplacement(desktopPath(args[0]), args[0])) return false;
      await run("omarchy-webapp-install", args, { signal });
    })} />}>
    <Form.TextField id="name" title="Name" placeholder="My web app" error={workflow.errors.name} />
    <Form.TextField id="url" title="URL" placeholder="https://example.com" error={workflow.errors.url} />
    <Form.TextField id="icon" title="Icon" placeholder="Automatic, icon name, image path, or URL" error={workflow.errors.icon} />
  </Form>;
}
