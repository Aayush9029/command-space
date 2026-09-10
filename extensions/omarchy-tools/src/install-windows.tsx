import os from "node:os";
import { Form, environment, confirmAlert } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { windowsConfiguration, launchTerminalOperation } from "./system-workflows.mjs";

export default function InstallWindows() {
  const workflow = useWorkflow();
  const memory = Math.floor(os.totalmem() / 1073741824);
  const ram = [2, 4, 8, 16, 32, 64].filter(size => size <= memory);
  const defaultRAM = `${ram.filter(size => size <= 4).at(-1) || ram[0] || 2}G`;
  return <Form navigationTitle="Install Windows VM" isLoading={workflow.busy} actions={<WorkflowActions title="Install Windows" workflow={workflow}
    onSubmit={values => workflow.submit("Continue in the authentication terminal", async signal => {
      const config = windowsConfiguration(values);
      if (!await confirmAlert({ title: "Install Windows VM?", message: `${config.ram} RAM · ${config.cores} CPU cores · ${config.disk} disk\nWindows username: ${config.username}`, primaryAction: { title: "Install" } })) return false;
      await launchTerminalOperation("windows", config, { assetsPath: environment.assetsPath, signal });
    })} />}>
    <Form.Dropdown id="ram" title="Memory" defaultValue={defaultRAM} error={workflow.errors.ram}>
      {ram.map(size => <Form.Dropdown.Item key={size} value={`${size}G`} title={`${size} GB`} />)}
    </Form.Dropdown>
    <Form.TextField id="cores" title="CPU Cores" defaultValue={String(Math.min(2, os.availableParallelism()))} error={workflow.errors.cores} />
    <Form.Dropdown id="disk" title="Disk" defaultValue="64G" error={workflow.errors.disk}>
      {[32, 64, 128, 256, 512].map(size => <Form.Dropdown.Item key={size} value={`${size}G`} title={`${size} GB`} />)}
    </Form.Dropdown>
    <Form.TextField id="username" title="Username" defaultValue="docker" error={workflow.errors.username} />
    <Form.PasswordField id="password" title="Password" error={workflow.errors.password} />
  </Form>;
}
