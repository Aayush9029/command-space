import { useState } from "react";
import { Form, environment } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { sshKeys, launchTerminalOperation } from "./system-workflows.ts";

export default function SetupSSHD() {
  const workflow = useWorkflow();
  const [source, setSource] = useState("manual");
  return <Form navigationTitle="Set Up SSH Access" isLoading={workflow.busy} actions={<WorkflowActions title="Set Up SSH" workflow={workflow}
    onSubmit={values => workflow.submit("Continue in the authentication terminal", async signal => {
      const keys = await sshKeys(values, { signal });
      await launchTerminalOperation("sshd", { keys }, { assetsPath: environment.assetsPath, signal });
    })} />}>
    <Form.Dropdown id="source" title="Key Source" value={source} onChange={setSource}>
      <Form.Dropdown.Item value="manual" title="Public Key" />
      <Form.Dropdown.Item value="github" title="GitHub" />
    </Form.Dropdown>
    {source === "github"
      ? <Form.TextField id="username" title="Username" placeholder="GitHub username" error={workflow.errors.username} />
      : <Form.TextArea id="key" title="Public Key" placeholder="ssh-ed25519 AAAA… user@host" error={workflow.errors.key} />}
    <Form.Description text="Authorizes your key, enables SSH, and turns off password login. Administrator authentication continues in the terminal." />
  </Form>;
}
