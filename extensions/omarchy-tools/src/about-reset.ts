import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { resetBranding } from "./branding.mjs";

export async function reset(target: string) {
  try { await resetBranding(target); await showToast({ style: Toast.Style.Success, title: "Default branding restored" }); await closeMainWindow(); }
  catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not restore branding", message: error.message }); }
}

export default function ResetAbout() { return reset("about"); }
