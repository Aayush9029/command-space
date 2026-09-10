import {useState} from "react";
import {MenuBarExtra, Icon, LocalStorage, confirmAlert, getPreferenceValues, environment} from "@raycast/api";

export default function Command() {
  const [count, setCount] = useState(0);
  return <MenuBarExtra title={`${getPreferenceValues().label}: ${count}`} icon={Icon.CheckCircle} tooltip={`Launch: ${environment.launchType}`}>
    <MenuBarExtra.Section title="Validation Actions">
      <MenuBarExtra.Item title="Increment Counter" onAction={async () => {setCount(count+1); await LocalStorage.setItem("counter",count+1);}}/>
      <MenuBarExtra.Submenu title="More Actions">
        <MenuBarExtra.Item title="Confirm Change" onAction={async () => {await LocalStorage.setItem("confirmed",await confirmAlert({title:"Save validation result?",primaryAction:{title:"Save"}}));}}/>
        <MenuBarExtra.Item title="Write Nested Result" onAction={async () => {await LocalStorage.setItem("nested",true); setCount(count+10);}}/>
      </MenuBarExtra.Submenu>
    </MenuBarExtra.Section>
  </MenuBarExtra>;
}
