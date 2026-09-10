import { useEffect, useState } from "react";
import { Form, Toast, showToast } from "@raycast/api";
import { useWorkflow, WorkflowActions } from "./components";
import { readBranding, writeBranding } from "./branding.mjs";

export function BrandingText({ target = "about" }) {
  const workflow = useWorkflow();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    readBranding(target).then(value => { if (active) setContent(value); })
      .catch(error => showToast({ style: Toast.Style.Failure, title: "Could not read branding", message: error.message }))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [target]);
  return <Form navigationTitle={target === "about" ? "About Text" : "Screensaver Text"} isLoading={loading || workflow.busy}
    actions={<WorkflowActions title="Save" workflow={{ ...workflow, busy: loading || workflow.busy }} onSubmit={values => workflow.submit("Branding updated", () => writeBranding(target, values.text))} />}>
    <Form.TextArea id="text" fontFamily="monospace" height={280} placeholder="Enter ASCII art or text" value={content} onChange={setContent} error={workflow.errors.text} />
  </Form>;
}

export default function AboutText() { return <BrandingText />; }
