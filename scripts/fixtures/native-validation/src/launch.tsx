import {Action, ActionPanel, LaunchType, List, launchCommand} from "@raycast/api";

export default function Command() {
  return <List><List.Item title="Launch Background Receiver" actions={<ActionPanel>
    <Action title="Launch" onAction={() => launchCommand({
      name:"receive", type:LaunchType.Background, arguments:{topic:"Omarchy"}, fallbackText:"native fallback",
      context:{date:new Date("2026-09-09T12:00:00Z"),buffer:Buffer.from("Command Space")},
    })}/>
  </ActionPanel>}/></List>;
}
