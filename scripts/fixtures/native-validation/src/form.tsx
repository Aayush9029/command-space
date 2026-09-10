import {useRef} from "react";
import {Form, ActionPanel, Action, LocalStorage, showToast} from "@raycast/api";

const events: unknown[] = [];
function record(event: Form.Event<unknown>) {
  events.push({type:event.type,id:event.target.id,value:event.target.value});
  return LocalStorage.setItem("focusEvents",JSON.stringify(events));
}

export default function Command() {
  const enabled = useRef<Form.Checkbox>(null);
  return <Form navigationTitle="Native Form Validation" actions={<ActionPanel>
    <Action.SubmitForm title="Save Values" onSubmit={async values => {await LocalStorage.setItem("form",JSON.stringify(values)); await showToast({title:"Validation saved"});}}/>
    <Action title="Focus Enabled" shortcut={{modifiers:["ctrl"],key:"e"}} onAction={() => enabled.current?.focus()}/>
    <ActionPanel.Submenu title="More Actions"><Action title="Write Action Result" onAction={async () => {await LocalStorage.setItem("actionPanel",true); await showToast({title:"Nested action verified"});}}/></ActionPanel.Submenu>
  </ActionPanel>}>
    <Form.TextField id="name" title="Name" defaultValue="Super Space" storeValue autoFocus onFocus={record} onBlur={record}/>
    <Form.DatePicker id="date" title="Date" defaultValue={new Date("2026-09-09T12:00:00Z")} onFocus={record} onBlur={record}/>
    <Form.Checkbox id="enabled" ref={enabled} label="Enabled" defaultValue onFocus={record} onBlur={record}/>
    <Form.Dropdown id="choice" title="Choice" defaultValue="one" onFocus={record} onBlur={record}>
      <Form.Dropdown.Item value="one" title="One"/><Form.Dropdown.Item value="two" title="Two"/>
    </Form.Dropdown>
    <Form.TagPicker id="tags" title="Tags" onFocus={record} onBlur={record}>
      <Form.TagPicker.Item value="alpha" title="Alpha"/><Form.TagPicker.Item value="beta" title="Beta"/>
    </Form.TagPicker>
    <Form.TextArea id="notes" title="Notes" defaultValue="Keyboard navigation" onFocus={record} onBlur={record}/>
    <Form.FilePicker id="files" title="Files" onFocus={record} onBlur={record}/>
  </Form>;
}
