import { useState } from "react";
import { List, ActionPanel, Action, Icon } from "@raycast/api";
import { createHash } from "node:crypto";

export default function TransformText() {
  const [text, setText] = useState("");
  const results = [
    { title: "Uppercase", value: text.toUpperCase() },
    { title: "Lowercase", value: text.toLowerCase() },
    { title: "Base64 Encode", value: Buffer.from(text).toString("base64") },
    { title: "Base64 Decode", value: Buffer.from(text, "base64").toString("utf8") },
    { title: "URL Encode", value: encodeURIComponent(text) },
    { title: "SHA-256", value: createHash("sha256").update(text).digest("hex") },
  ];
  return <List searchBarPlaceholder="Enter text to transform…" onSearchTextChange={setText} filtering={false}>
    <List.Section title="Transformations">
      {results.map(result => <List.Item key={result.title} title={result.title} subtitle={result.value} icon={Icon.Text}
        actions={<ActionPanel><Action.CopyToClipboard title={`Copy ${result.title}`} content={result.value} /></ActionPanel>} />)}
    </List.Section>
  </List>;
}
