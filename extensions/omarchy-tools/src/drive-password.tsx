import { errorMessage } from "./workflows.ts";
import { useEffect, useState } from "react";
import { Form, environment, Toast, showToast } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { discoverEncryptedDrives, drivePassword, launchTerminalOperation } from "./system-workflows.ts";

export default function DrivePassword() {
  const workflow = useWorkflow();
  const [drives, setDrives] = useState<{ path: string, title: string }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    discoverEncryptedDrives(undefined, controller.signal).then(drives => { if (!controller.signal.aborted) setDrives(drives); })
      .catch(error => { if (!controller.signal.aborted) showToast({ style: Toast.Style.Failure, title: "Could not list encrypted drives", message: errorMessage(error) }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <Form navigationTitle="Change Drive Passphrase" isLoading={loading || workflow.busy}
    actions={<WorkflowActions title="Change Passphrase" workflow={workflow} onSubmit={values => workflow.submit("Continue in the authentication terminal", async signal => {
      const operation = await drivePassword(values, { signal });
      await launchTerminalOperation("drive-password", operation, { assetsPath: environment.assetsPath, signal });
    })} />}>
    <Form.Dropdown id="drive" title="Drive" error={workflow.errors.drive || (!loading && !drives.length ? "No encrypted drives found" : undefined)}>
      {drives.map(drive => <Form.Dropdown.Item key={drive.path} value={drive.path} title={drive.title} />)}
    </Form.Dropdown>
    <Form.PasswordField id="password" title="New Passphrase" error={workflow.errors.password} />
    <Form.PasswordField id="confirmation" title="Confirm Passphrase" error={workflow.errors.confirmation} />
    <Form.Description text="The current drive passphrase and administrator authentication stay in the terminal." />
  </Form>;
}
