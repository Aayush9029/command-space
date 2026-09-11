import { Activity, Fragment, useCallback, useLayoutEffect, useRef, useState, type FragmentInstance, type RefCallback } from "react";
import { Action, ActionPanel, Form, LocalStorage, showToast } from "@raycast/api";

const layouts = ["initial", "reversed", "removed", "empty", "restored", "hidden", "visible", "unmounted"] as const;
type Layout = typeof layouts[number];
type FieldID = "first" | "second";
interface RefEvent {
  kind: "focus" | "blur" | "attach" | "cleanup" | "layout" | "action";
  id?: string;
  phase?: Layout;
  value?: unknown;
}

export default function Command() {
  const [phase, setPhase] = useState<Layout>("initial");
  const group = useRef<FragmentInstance>(null);
  const first = useRef<Form.TextField>(null);
  const second = useRef<Form.TextField>(null);
  const outsideAfter = useRef<Form.TextField>(null);
  const retiredFirst = useRef<Form.TextField>(null);
  const retiredGroup = useRef<FragmentInstance>(null);
  const events = useRef<RefEvent[]>([]);
  const record = useCallback((event: RefEvent) => {
    events.current.push(event);
    return LocalStorage.setItem("refsEvents", events.current);
  }, []);
  const secondRef = useCallback<RefCallback<Form.TextField>>(instance => {
    second.current = instance;
    if (!instance) return;
    void record({ kind: "attach", id: "second" });
    return () => {
      second.current = null;
      void record({ kind: "cleanup", id: "second" });
    };
  }, [record]);
  const fieldEvent = useCallback((event: Form.Event<unknown>) => {
    if (event.type !== "focus" && event.type !== "blur") return;
    void record({ kind: event.type, id: event.target.id, value: event.target.value });
    if (event.type === "focus") void LocalStorage.setItem("refsFocused", event.target.id);
  }, [record]);

  const ids: FieldID[] = phase === "empty" ? [] : phase === "removed" ? ["second"] : phase === "reversed" ? ["second", "first"] : ["first", "second"];
  useLayoutEffect(() => {
    retiredFirst.current ||= first.current;
    retiredGroup.current ||= group.current;
    void record({ kind: "layout", phase });
    void LocalStorage.setItem("refsState", {
      phase,
      groupAttached: group.current !== null,
      sameGroup: group.current === retiredGroup.current,
      firstAttached: first.current !== null,
      secondAttached: second.current !== null,
      sameFirst: first.current === retiredFirst.current,
    });
    if (phase === "empty" || phase === "hidden" || phase === "unmounted") outsideAfter.current?.focus();
    else group.current?.focusLast();
  }, [phase, record]);

  async function useRetiredRefs() {
    outsideAfter.current?.focus();
    retiredFirst.current?.focus();
    retiredFirst.current?.reset();
    if (phase === "unmounted") {
      retiredGroup.current?.focus();
      retiredGroup.current?.focusLast();
    }
    await record({ kind: "action", id: "retired", phase });
  }

  return <Form navigationTitle={`React Refs · ${phase}`} actions={<ActionPanel>
    <Action.SubmitForm title="Save Ref Values" shortcut={{ modifiers: ["ctrl", "shift"], key: "v" }} onSubmit={async values => {
      await LocalStorage.setItem("refsValues", values);
      await showToast({ title: "Ref values saved" });
    }} />
    <Action title="Next Layout" shortcut={{ modifiers: ["ctrl", "shift"], key: "n" }} onAction={() => setPhase(current => layouts[(layouts.indexOf(current) + 1) % layouts.length]!)} />
    <Action title="Focus First in Group" shortcut={{ modifiers: ["ctrl", "shift"], key: "f" }} onAction={() => group.current?.focus()} />
    <Action title="Focus Last in Group" shortcut={{ modifiers: ["ctrl", "shift"], key: "l" }} onAction={() => group.current?.focusLast()} />
    <Action title="Reset First Field" shortcut={{ modifiers: ["ctrl", "shift"], key: "r" }} onAction={() => { first.current?.focus(); first.current?.reset(); }} />
    <Action title="Use Retired Refs" shortcut={{ modifiers: ["ctrl", "shift"], key: "s" }} onAction={useRetiredRefs} />
  </ActionPanel>}>
    <Form.TextField id="outside-before" title="Outside Before" defaultValue="Before" onFocus={fieldEvent} onBlur={fieldEvent} />
    {phase !== "unmounted" && <Fragment ref={group}>
      <Form.Description id="description" text="The group skips this description and the disabled field when focusing." />
      <Form.TextField id="disabled" title="Disabled" defaultValue="Unchanged" disabled onFocus={fieldEvent} onBlur={fieldEvent} />
      <Activity mode={phase === "hidden" ? "hidden" : "visible"}>
        {ids.map(id => <Form.TextField key={id} id={id} title={id === "first" ? "First" : "Second"}
          defaultValue={id === "first" ? "First initial" : "Second initial"}
          ref={id === "first" ? first : secondRef} onFocus={fieldEvent} onBlur={fieldEvent} />)}
      </Activity>
    </Fragment>}
    <Form.TextField id="outside-after" title="Outside After" defaultValue="After" ref={outsideAfter} onFocus={fieldEvent} onBlur={fieldEvent} />
  </Form>;
}
