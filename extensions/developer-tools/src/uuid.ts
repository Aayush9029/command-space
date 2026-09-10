import { randomUUID } from "node:crypto";
import { Clipboard, showHUD } from "@raycast/api";

export default async function GenerateUUID() {
  const uuid = randomUUID();
  await Clipboard.copy(uuid);
  await showHUD("UUID copied to clipboard");
}
