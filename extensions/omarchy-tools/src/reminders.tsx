import { useCallback, useEffect, useState } from "react";
import { Action, ActionPanel, Icon, List, Toast, showToast, confirmAlert } from "@raycast/api";
import Reminder from "./reminder";
import { run } from "./workflows.mjs";

export default function Reminders() {
  const [reminders, setReminders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setReminders(JSON.parse(await run("omarchy-reminder", ["show", "--json"])).reminders || []); }
    catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not load reminders", message: error.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 30000); return () => clearInterval(timer); }, [refresh]);
  const actions = <ActionPanel>
    <Action.Push title="Set Reminder" target={<Reminder />} />
    <Action title="Refresh" shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={refresh} />
    {reminders.length > 0 && <Action title="Clear All Reminders" style={Action.Style.Destructive} onAction={async () => {
      if (!await confirmAlert({ title: "Clear all reminders?", primaryAction: { title: "Clear All", style: Action.Style.Destructive } })) return;
      try { await run("omarchy-reminder", ["clear"]); await refresh(); }
      catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not clear reminders", message: error.message }); }
    }} />}
  </ActionPanel>;
  return <List navigationTitle="Reminders" isLoading={loading} actions={actions}>
    <List.EmptyView icon={Icon.Clock} title="No upcoming reminders" actions={actions} />
    {reminders.map(reminder => <List.Item key={reminder.unit} id={reminder.unit} title={reminder.label}
      icon={Icon.Clock} subtitle={reminder.atTime} accessories={[{ text: reminder.remaining }]} actions={actions} />)}
  </List>;
}
