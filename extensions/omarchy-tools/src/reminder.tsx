import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, run } from "./components";
import { reminderArguments } from "./workflows.mjs";

export default function Reminder() {
  const workflow = useWorkflow();
  return <Form navigationTitle="Set Reminder" isLoading={workflow.busy} actions={<WorkflowActions title="Set Reminder" workflow={workflow}
    onSubmit={values => workflow.submit("Reminder set", signal => run("omarchy-reminder", reminderArguments(values), { signal }))} />}>
    <Form.TextField id="message" title="Reminder" placeholder="Take a break" error={workflow.errors.message} />
    <Form.TextField id="minutes" title="In Minutes" defaultValue="5" error={workflow.errors.minutes} />
  </Form>;
}
