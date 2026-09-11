import { errorMessage } from "./workflows.ts";
import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { resetBranding, type BrandingTarget } from "./branding.ts";

export async function reset(target: BrandingTarget) {
  try { await resetBranding(target); await showToast({ style: Toast.Style.Success, title: "Default branding restored" }); await closeMainWindow(); }
  catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not restore branding", message: errorMessage(error) }); }
}

export default function ResetAbout() { return reset("about"); }
