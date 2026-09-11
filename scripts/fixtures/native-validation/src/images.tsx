import { useCallback, useEffect, useRef, useState } from "react";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Action, ActionPanel, Grid, Image, LocalStorage, environment } from "@raycast/api";

type Phase = "initial" | "replaced" | "corrupt" | "recovered";
interface ImageProbe {
  phase: Phase;
  source: string;
  sha256: string;
  bytes: number;
  modified: number;
  revision: number;
  warm: boolean;
}

function artwork(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/><circle cx="48" cy="48" r="27" fill="#ffffff"/><circle cx="48" cy="48" r="13" fill="${color}"/></svg>`;
}

export default function Command() {
  const [probe, setProbe] = useState<ImageProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<ImageProbe | null>(null);
  const mounted = useRef(false);
  const active = useRef(false);
  const source = path.join(environment.supportPath, "image-probe", "sample.svg");
  const publish = useCallback(async (next: ImageProbe) => {
    await LocalStorage.setItem("imageProbe", next);
    current.current = next;
    if (mounted.current) setProbe(next);
  }, []);
  const write = useCallback(async (phase: Phase) => {
    if (active.current) return;
    active.current = true;
    if (mounted.current) { setBusy(true); setError(""); }
    const temporary = `${source}.next`;
    try {
      await fs.mkdir(path.dirname(source), { recursive: true });
      const content = phase === "corrupt" ? "invalid image for cache validation" : artwork(phase === "replaced" ? "#ff8800" : "#00cc66");
      await fs.writeFile(temporary, content);
      await fs.rename(temporary, source);
      const metadata = await fs.stat(source);
      await publish({ phase, source, sha256: createHash("sha256").update(content).digest("hex"), bytes: metadata.size,
        modified: metadata.mtimeMs, revision: (current.current?.revision || 0) + 1, warm: false });
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      await fs.rm(temporary, { force: true });
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [publish, source]);
  useEffect(() => {
    mounted.current = true;
    void write("initial");
    return () => { mounted.current = false; };
  }, [write]);

  const actions = <ActionPanel>
    <Action title="Replace Image" shortcut={{ modifiers: ["ctrl", "shift"], key: "p" }} onAction={() => write("replaced")} />
    <Action title="Corrupt Image" shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }} onAction={() => write("corrupt")} />
    <Action title="Recover Image" shortcut={{ modifiers: ["ctrl", "shift"], key: "r" }} onAction={() => write("recovered")} />
    <Action title="Warm Rerender" shortcut={{ modifiers: ["ctrl", "shift"], key: "w" }} onAction={async () => {
      if (!active.current && current.current) await publish({ ...current.current, revision: current.current.revision + 1, warm: true });
    }} />
  </ActionPanel>;
  return <Grid columns={3} isLoading={busy} navigationTitle={`Image Cache · ${probe?.phase || "loading"} · ${probe?.revision || 0}`} actions={actions}>
    {error ? <Grid.EmptyView title="Image fixture failed" description={error} /> : probe && <Grid.Section title={`${probe.phase} · ${probe.sha256.slice(0, 12)}`}>
      <Grid.Item id="source" title="Source" subtitle="Square" content={{ source, fallback: "⚠️" }} actions={actions} />
      <Grid.Item id="circle" title="Circle" subtitle="Circle mask" content={{ source, mask: Image.Mask.Circle, fallback: "⚠️" }} actions={actions} />
      <Grid.Item id="rounded" title="Rounded" subtitle="Rounded rectangle mask" content={{ source, mask: Image.Mask.RoundedRectangle, fallback: "⚠️" }} actions={actions} />
    </Grid.Section>}
  </Grid>;
}
