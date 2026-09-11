import { useCallback, useEffect, useRef, useState } from "react";
import { Action, ActionPanel, Icon, List, Toast, showToast, confirmAlert } from "@raycast/api";
import Reminder from "./reminder";
import { errorMessage, parseReminders, run, type ReminderEntry } from "./workflows.ts";

export default function Reminders() {
  const [reminders, setReminders] = useState<ReminderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    try {
      const result = parseReminders(await run("omarchy-reminder", ["show", "--json"], { signal: controller.signal }));
      if (!controller.signal.aborted) setReminders(result);
    } catch (error) {
      if (!controller.signal.aborted) await showToast({ style: Toast.Style.Failure, title: "Could not load reminders", message: errorMessage(error) });
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => { mounted.current = false; clearInterval(timer); active.current?.abort(); };
  }, [refresh]);
  const actions = <ActionPanel>
    <Action.Push title="Set Reminder" target={<Reminder />} />
    <Action title="Refresh" shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={refresh} />
    {reminders.length > 0 && <Action title="Clear All Reminders" style={Action.Style.Destructive} onAction={async () => {
      if (!await confirmAlert({ title: "Clear all reminders?", primaryAction: { title: "Clear All", style: Action.Style.Destructive } })) return;
      try { await run("omarchy-reminder", ["clear"]); await refresh(); }
      catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not clear reminders", message: errorMessage(error) }); }
    }} />}
  </ActionPanel>;
  return <List navigationTitle="Reminders" isLoading={loading} actions={actions}>
    <List.EmptyView icon={Icon.Clock} title="No upcoming reminders" actions={actions} />
    {reminders.map(reminder => <List.Item key={reminder.unit} id={reminder.unit} title={reminder.label}
      icon={Icon.Clock} subtitle={reminder.atTime} accessories={[{ text: reminder.remaining }]} actions={actions} />)}
  </List>;
}
