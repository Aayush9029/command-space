import { useEffect, useRef, useState } from "react";
import { Form } from "@raycast/api";
import { useWorkflow, WorkflowActions, FileField, run } from "./components";
import { errorMessage, mediaKind, selectedPaths, transcodeArguments } from "./workflows.ts";

export default function Transcode() {
  const workflow = useWorkflow();
  const [kind, setKind] = useState("image");
  const [files, setFiles] = useState<string[]>([]);
  const [format, setFormat] = useState("jpg");
  const [resolution, setResolution] = useState("high");
  const [fileError, setFileError] = useState("");
  const probe = useRef<AbortController | null>(null);
  useEffect(() => () => probe.current?.abort(), []);
  async function selectFiles(paths: string[]) {
    probe.current?.abort();
    const controller = new AbortController();
    probe.current = controller;
    setFiles(paths);
    setFileError("");
    if (!paths.length) return;
    try {
      const [file] = await selectedPaths(paths, { multiple: false });
      const type = await mediaKind(file, run, controller.signal);
      if (controller.signal.aborted) return;
      setKind(type);
      setFormat(type === "image" ? "jpg" : "mp4");
      setResolution(type === "image" ? "high" : "1080p");
    } catch (error) { if (!controller.signal.aborted) setFileError(errorMessage(error)); }
  }
  return <Form navigationTitle="Transcode Media" isLoading={workflow.busy} actions={<WorkflowActions title="Convert" workflow={workflow}
    onSubmit={values => workflow.submit("Converted and copied", async signal => {
      const result = await transcodeArguments(values, run, signal);
      await run("omarchy-transcode", result.args, { signal, timeout: 7200000 });
    })} />}>
    <FileField errors={{ ...workflow.errors, files: fileError || workflow.errors.files }} value={files} onChange={selectFiles} />
    <Form.Dropdown id="format" title="Format" value={format} onChange={setFormat} error={workflow.errors.format}>
      {(kind === "image" ? ["jpg", "png"] : ["mp4", "gif"]).map(value => <Form.Dropdown.Item key={value} value={value} title={value.toUpperCase()} />)}
    </Form.Dropdown>
    <Form.Dropdown id="resolution" title="Resolution" value={resolution} onChange={setResolution} error={workflow.errors.resolution}>
      {(kind === "image" ? ["high", "medium", "low"] : ["4k", "1080p", "720p"]).map(value => <Form.Dropdown.Item key={value} value={value} title={value === "4k" ? "4K" : value[0].toUpperCase() + value.slice(1)} />)}
    </Form.Dropdown>
  </Form>;
}
