import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { configureDNS } from "./system-workflows.ts";

export default function CustomDNS() {
  const workflow = useWorkflow();
  return <Form navigationTitle="Custom DNS" isLoading={workflow.busy} actions={<WorkflowActions title="Apply DNS" workflow={workflow}
    onSubmit={values => workflow.submit("DNS updated", signal => configureDNS(values, { signal }))} />}>
    <Form.TextField id="servers" title="Servers" placeholder="192.168.1.1 1.1.1.1" error={workflow.errors.servers} />
  </Form>;
}
