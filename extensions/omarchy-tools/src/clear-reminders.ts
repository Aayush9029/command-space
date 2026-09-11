import { Action, Toast, showToast, confirmAlert, closeMainWindow } from "@raycast/api";
import { errorMessage, run } from "./workflows.ts";

export default async function ClearReminders() {
  if (!await confirmAlert({ title: "Clear all reminders?", primaryAction: { title: "Clear All", style: Action.Style.Destructive } })) return;
  try {
    await run("omarchy-reminder", ["clear"]);
    await showToast({ style: Toast.Style.Success, title: "Reminders cleared" });
    await closeMainWindow();
  } catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not clear reminders", message: errorMessage(error) }); }
}
