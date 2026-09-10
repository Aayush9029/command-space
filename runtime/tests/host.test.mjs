import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture(t, mode, source, metadata = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "command-space-extension-"));
  const extension = path.join(home, "fixture");
  await mkdir(path.join(extension, "src"), { recursive: true });
  await writeFile(path.join(extension, "package.json"), JSON.stringify({ name: "fixture", ...metadata, commands: [{ name: "command", title: "Fixture", mode, ...(metadata.command || {}) }] }));
  await writeFile(path.join(extension, "src/command.tsx"), source);
  await mkdir(path.join(home, "bin"));
  await writeFile(path.join(home, "bin/xdg-open"), "#!/bin/sh\nexit 0\n", {mode:0o755});
  const process = spawn(globalThis.process.execPath, [path.join(runtime, "host.mjs")], { env: { ...globalThis.process.env, HOME: home, COMMAND_SPACE_TOKEN_STORAGE:"file", PATH:`${home}/bin:${globalThis.process.env.PATH}`, XDG_DATA_HOME: path.join(home, "data") } });
  const messages = [];
  let stderr = "";
  const lines = readline.createInterface({ input: process.stdout });
  lines.on("line", line => messages.push(JSON.parse(line)));
  process.stderr.on("data", data => { stderr += data; });
  t.after(async () => { process.kill(); await rm(home, { recursive: true, force: true }); });
  const send = value => process.stdin.write(`${JSON.stringify(value)}\n`);
  async function wait(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const error = messages.find(message => message.type === "error");
      if (error) throw new Error(error.message);
      const result = messages.find(predicate);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Extension timed out: ${JSON.stringify(messages)} ${stderr}`);
  }
  send({ type: "launch", extension, command: "command" });
  return { home, extension, send, wait, messages };
}

test("rapid field events use the current React callback and acknowledge the latest edit", async t => {
  const host = await fixture(t, "view", `import { useState } from 'react'; import { Form } from '@raycast/api';
    export default function Command() { const [value,setValue] = useState(''); return <Form><Form.TextArea id="input" value={value} onChange={setValue}/></Form>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.id === "input"));
  const callback = nodes(first.tree).find(n => n.props.id === "input").props.onChange.$callback;
  for (let index = 1; index <= 100; index++) host.send({type:"event",callback,field:"input",inputRevision:index,args:["a".repeat(index)]});
  const last = await host.wait(m => m.type === "render" && m.inputRevision === 100);
  assert.equal(nodes(last.tree).find(n => n.props.id === "input").props.value, "a".repeat(100));
});

test("OAuth browser failure cancels the pending callback request", async t => {
  const host = await fixture(t, "no-view", `import { OAuth, LocalStorage } from '@raycast/api';
    export default async function Command() { const client = new OAuth.PKCEClient({providerName:'Fixture'});
      const request = await client.authorizationRequest({endpoint:'https://provider.example/authorize',clientId:'fixture'});
      try { await client.authorize(request); } catch (error) { await LocalStorage.setItem('error',error.message); } }`);
  const consent = await host.wait(m => m.type === "request" && m.kind === "confirm");
  await writeFile(path.join(host.home,"bin/xdg-open"), "#!/bin/sh\nexit 1\n", {mode:0o755});
  host.send({type:"response",id:consent.id,value:true});
  await host.wait(m => m.type === "cancel-request");
  await host.wait(m => m.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home,"data/command-space/extension-data/fixture/storage.json"),"utf8"));
  assert.match(saved.error,/Could not open/);
});

function nodes(tree) { return tree.flatMap(node => [node, ...nodes(node.children || [])]); }

test("no-view confirmations keep reading responses while the command waits", async t => {
  const host = await fixture(t, "no-view", `import { confirmAlert, LocalStorage } from '@raycast/api';
    export default async function Command() { await LocalStorage.setItem('confirmed', await confirmAlert({ title: 'Continue?' })); }`);
  const request = await host.wait(message => message.type === "request" && message.kind === "confirm");
  host.send({ type: "response", id: request.id, value: true });
  await host.wait(message => message.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home, "data/command-space/extension-data/fixture/storage.json"), "utf8"));
  assert.equal(saved.confirmed, true);
});

test("an asynchronous action can await a confirmation and rerender", async t => {
  const host = await fixture(t, "view", `import { useState } from 'react';
    import { List, Action, ActionPanel, confirmAlert } from '@raycast/api';
    export default function Command() {
      const [title, setTitle] = useState('Waiting');
      return <List><List.Item title={title} actions={<ActionPanel><Action title="Confirm" onAction={async () => setTitle(await confirmAlert({title:'Confirm change?'}) ? 'Accepted' : 'Canceled')}/></ActionPanel>}/></List>;
    }`);
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action"));
  const action = nodes(first.tree).find(node => node.type === "Action");
  host.send({ type: "event", callback: action.props.onAction.$callback, args: [] });
  const request = await host.wait(message => message.type === "request");
  host.send({ type: "response", id: request.id, value: false });
  await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.title === "Canceled"));
});

test("TypeScript no-view commands use real persistent storage and toasts", async t => {
  const host = await fixture(t, "no-view", `import { LocalStorage, showHUD } from '@raycast/api';
    export default async function Command() { await LocalStorage.setItem('answer', 42); await showHUD('Saved'); }`);
  await host.wait(message => message.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home, "data/command-space/extension-data/fixture/storage.json"), "utf8"));
  assert.equal(saved.answer, 42);
  assert.ok(host.messages.some(message => message.type === "toast" && message.title === "Saved"));
});

test("React hooks, TSX, search events, and action callbacks rerender native trees", async t => {
  const host = await fixture(t, "view", `import { useState } from 'react';
    import { List, Action, ActionPanel } from '@raycast/api';
    export default function Command() {
      const [query, setQuery] = useState('initial'); const [count, setCount] = useState(0);
      return <List onSearchTextChange={setQuery} filtering={false}><List.Item title={query} subtitle={String(count)} actions={<ActionPanel><Action title="Increment" onAction={() => setCount(count + 1)}/></ActionPanel>}/></List>;
    }`);
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item"));
  const list = nodes(first.tree).find(node => node.type === "List");
  assert.ok(list.props.onSearchTextChange.$callback);
  host.send({ type: "event", callback: list.props.onSearchTextChange.$callback, args: ["changed"] });
  const changed = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item" && node.props.title === "changed"));
  const action = nodes(changed.tree).find(node => node.type === "Action");
  host.send({ type: "event", callback: action.props.onAction.$callback, args: [] });
  const updated = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item" && node.props.subtitle === "1"));
  assert.ok(updated);
});


test("command arguments render a form, validate required values, and reach the command", async t => {
  const host = await fixture(t, "no-view", `import { LocalStorage } from '@raycast/api';
    export default async function Command(props) { await LocalStorage.setItem('arguments', props.arguments); }`,
    { command: { arguments: [{ name: 'topic', type: 'text', required: true, placeholder: 'Topic' }] } });
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Form.TextField"));
  const action = nodes(first.tree).find(node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: action.props.onAction.$callback, args: [{ topic: "" }] });
  const invalid = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.error === "This field is required"));
  const submit = nodes(invalid.tree).find(node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: submit.props.onAction.$callback, args: [{ topic: "Omarchy" }] });
  await host.wait(message => message.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home, "data/command-space/extension-data/fixture/storage.json"), "utf8"));
  assert.deepEqual(saved.arguments, { topic: "Omarchy" });
});

test("required preferences persist and are available when the command runs", async t => {
  const host = await fixture(t, "no-view", `import { LocalStorage, getPreferenceValues } from '@raycast/api';
    export default async function Command() { await LocalStorage.setItem('configured', getPreferenceValues().endpoint); }`,
    { preferences: [{ name: 'endpoint', type: 'textfield', title: 'Endpoint', required: true }] });
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Form.TextField"));
  const submit = nodes(first.tree).find(node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: submit.props.onAction.$callback, args: [{ endpoint: "https://example.test" }] });
  await host.wait(message => message.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home, "data/command-space/extension-data/fixture/preferences.json"), "utf8"));
  assert.equal(saved.extension.endpoint, "https://example.test");
  const storage = JSON.parse(await readFile(path.join(host.home, "data/command-space/extension-data/fixture/storage.json"), "utf8"));
  assert.equal(storage.configured, "https://example.test");
});

test("date picker values arrive as Date objects in form submission", async t => {
  const host = await fixture(t, "view", `import { Form, Action, ActionPanel, LocalStorage } from '@raycast/api';
    export default function Command() {
      return <Form actions={<ActionPanel><Action.SubmitForm onSubmit={async values => { await LocalStorage.setItem('date', values.date.toISOString()); }}/></ActionPanel>}><Form.DatePicker id="date" title="Date"/></Form>;
    }`);
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  const action = nodes(first.tree).find(node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: action.props.onAction.$callback, args: [{ date: "2026-09-09T12:00:00Z" }] });
  const file = path.join(host.home, "data/command-space/extension-data/fixture/storage.json");
  let saved;
  for (let i = 0; i < 50; i++) { try { saved = JSON.parse(await readFile(file, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  assert.equal(saved.date, "2026-09-09T12:00:00.000Z");
});

test("cache subscriptions update without exposing cached keys through LocalStorage", async t => {
  const host = await fixture(t, "no-view", `import { Cache, LocalStorage } from '@raycast/api';
    export default async function Command() {
      const cache = new Cache({namespace:'test'});
      await new Promise(resolve => { const stop = cache.subscribe(() => { stop(); resolve(); }); cache.set('value', 'updated'); });
      await LocalStorage.setItem('cacheValue', cache.get('value'));
      await LocalStorage.setItem('cacheEmpty', cache.isEmpty);
    }`);
  await host.wait(message => message.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home, "data/command-space/extension-data/fixture/storage.json"), "utf8"));
  assert.deepEqual(saved, { cacheValue: "updated", cacheEmpty: false });
});

test("navigation preserves mounted React state and invokes the pop callback", async t => {
  const host = await fixture(t, "view", `import { useState } from 'react';
    import { List, Detail, Action, ActionPanel, useNavigation } from '@raycast/api';
    export default function Command() {
      const [count, setCount] = useState(0); const [returned, setReturned] = useState(false); const { push } = useNavigation();
      return <List><List.Item title={String(count)} subtitle={returned ? 'returned' : 'initial'} actions={<ActionPanel>
        <Action title="Increment" onAction={() => setCount(value => value + 1)}/>
        <Action title="Next" onAction={() => push(<Detail markdown="Second page"/>, () => setReturned(true))}/>
      </ActionPanel>}/></List>;
    }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.title === "Increment"));
  host.send({ type:"event", callback:nodes(first.tree).find(n => n.props.title === "Increment").props.onAction.$callback });
  const updated = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.type === "List.Item" && n.props.title === "1"));
  host.send({ type:"event", callback:nodes(updated.tree).find(n => n.props.title === "Next").props.onAction.$callback });
  await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.markdown === "Second page"));
  host.send({ type:"pop" });
  const returned = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.subtitle === "returned"));
  assert.equal(nodes(returned.tree).find(n => n.type === "List.Item").props.title, "1");
});

test("form references focus and reset the native field to its initial value", async t => {
  const host = await fixture(t, "view", `import { useRef } from 'react';
    import { Form, Action, ActionPanel } from '@raycast/api';
    export default function Command() {
      const field = useRef(null);
      return <Form actions={<ActionPanel><Action title="Reset" onAction={() => { field.current.focus(); field.current.reset(); }}/></ActionPanel>}>
        <Form.TextField id="name" ref={field} defaultValue="initial"/>
      </Form>;
    }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.title === "Reset"));
  host.send({ type:"event", callback:nodes(first.tree).find(n => n.props.title === "Reset").props.onAction.$callback });
  await host.wait(m => m.type === "field-command" && m.operation === "focus");
  const reset = await host.wait(m => m.type === "field-command" && m.operation === "reset");
  assert.equal(reset.id, "name");
  assert.equal(reset.value, "initial");
});

test("stored form values survive submission but exclude abandoned and rejected edits", async t => {
  const host = await fixture(t,"view", `import { Form, Action, ActionPanel } from '@raycast/api';
    export default function Command() { return <Form actions={<ActionPanel><Action.SubmitForm onSubmit={values => values.remembered !== 'invalid'}/></ActionPanel>}><Form.TextField id="remembered" storeValue defaultValue="first"/><Form.TextField id="temporary"/></Form>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.id === "remembered"));
  const action = nodes(first.tree).find(n => n.type === "Action.SubmitForm");
  const file = path.join(host.home,"data/command-space/extension-data/fixture/form-values.json");
  await assert.rejects(stat(file), {code:"ENOENT"});
  host.send({type:"event",callback:action.props.onAction.$callback,args:[{remembered:"invalid"}]});
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(stat(file), {code:"ENOENT"});
  host.send({type:"event",callback:action.props.onAction.$callback,args:[{remembered:"restored value",temporary:"do not store"}]});
  let saved;
  for (let i=0;i<100;i++) { try {saved=JSON.parse(await readFile(file,"utf8"));break;} catch {await new Promise(resolve => setTimeout(resolve,10));} }
  assert.deepEqual(saved.command,{remembered:"restored value"});
  host.send({type:"launch",extension:host.extension,command:"command"});
  await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.defaultValue === "restored value"));
});

test("date focus events restore Date values and non-text refs reach the native field", async t => {
  const host = await fixture(t,"view", `import {useRef} from 'react'; import {Form,Action,ActionPanel,LocalStorage} from '@raycast/api';
    export default function Command() { const field = useRef(null); return <Form actions={<ActionPanel><Action title="Focus checkbox" onAction={() => field.current.focus()}/></ActionPanel>}>
      <Form.DatePicker id="date" onFocus={event => LocalStorage.setItem('focus',{type:event.type,id:event.target.id,date:event.target.value.toISOString()})} onBlur={event => LocalStorage.setItem('blur',event.target.value)}/>
      <Form.Checkbox id="enabled" ref={field} label="Enabled"/>
    </Form>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.id === "date"));
  const date = nodes(first.tree).find(n => n.props.id === "date");
  host.send({type:"event",callback:date.props.onFocus.$callback,args:[{type:"focus",target:{id:"date",value:"2026-09-17T12:00:00Z"}}]});
  host.send({type:"event",callback:date.props.onBlur.$callback,args:[{type:"blur",target:{id:"date",value:null}}]});
  const action = nodes(first.tree).find(n => n.props.title === "Focus checkbox");
  host.send({type:"event",callback:action.props.onAction.$callback});
  const focus = await host.wait(m => m.type === "field-command");
  assert.deepEqual(focus,{type:"field-command",operation:"focus",id:"enabled"});
  const saved = JSON.parse(await readFile(path.join(host.home,"data/command-space/extension-data/fixture/storage.json"),"utf8"));
  assert.deepEqual(saved,{focus:{type:"focus",id:"date",date:"2026-09-17T12:00:00.000Z"},blur:null});
});

test("OAuth uses S256 PKCE, checks callback state, and stores expiring tokens privately", async t => {
  const host = await fixture(t, "no-view", `import { OAuth, LocalStorage } from '@raycast/api';
    export default async function Command() {
      const client = new OAuth.PKCEClient({providerName:'Fixture',redirectMethod:OAuth.RedirectMethod.App});
      const request = await client.authorizationRequest({endpoint:'https://provider.example/authorize', clientId:'fixture',scope:'read',extraParameters:{prompt:'consent'}});
      await LocalStorage.setItem('request',{verifier:request.codeVerifier,challenge:request.codeChallenge,url:request.toURL()});
      const result = await client.authorize(request);
      await client.setTokens({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_in:3600});
      const tokens = await client.getTokens();
      await LocalStorage.setItem('result',{code:result.authorizationCode,expired:tokens.isExpired(),date:tokens.updatedAt instanceof Date,token:tokens.accessToken});
    }`);
  const consent = await host.wait(m => m.type === "request" && m.kind === "confirm");
  host.send({type:"response",id:consent.id,value:true});
  const authorization = await host.wait(m => m.type === "request" && m.kind === "oauth");
  host.send({type:"response",id:authorization.id,value:`raycast://oauth?code=fixture-code&state=${authorization.options.state}`});
  await host.wait(m => m.type === "done");
  const folder = path.join(host.home,"data/command-space/extension-data/fixture");
  const saved = JSON.parse(await readFile(path.join(folder,"storage.json"),"utf8"));
  assert.equal(createHash("sha256").update(saved.request.verifier).digest("base64url"), saved.request.challenge);
  assert.equal(new URL(saved.request.url).searchParams.get("prompt"),"consent");
  assert.deepEqual(saved.result,{code:"fixture-code",expired:false,date:true,token:"fixture-token"});
  const tokenFile = (await readdir(path.join(folder,"oauth")))[0];
  assert.equal((await stat(path.join(folder,"oauth",tokenFile))).mode & 0o777,0o600);
});

test("OAuth rejects an unrelated callback instead of accepting its code", async t => {
  const host = await fixture(t, "no-view", `import { OAuth, LocalStorage } from '@raycast/api';
    export default async function Command() {
      const client = new OAuth.PKCEClient({providerName:'Fixture',redirectMethod:OAuth.RedirectMethod.App});
      const request = await client.authorizationRequest({endpoint:'https://provider.example/authorize',clientId:'fixture',scope:'read'});
      try { await client.authorize(request); } catch (error) { await LocalStorage.setItem('error',error.message); }
    }`);
  const consent = await host.wait(m => m.type === "request" && m.kind === "confirm");
  host.send({type:"response",id:consent.id,value:true});
  const authorization = await host.wait(m => m.type === "request" && m.kind === "oauth");
  host.send({type:"response",id:authorization.id,value:"raycast://oauth?code=wrong-code&state=unrelated"});
  await host.wait(m => m.type === "done");
  const saved = JSON.parse(await readFile(path.join(host.home,"data/command-space/extension-data/fixture/storage.json"),"utf8"));
  assert.match(saved.error,/state did not match/);
});


test("menu-bar commands retain React state, nested callbacks, and background launch context", async t => {
  const host = await fixture(t, "menu-bar", `import {useState} from 'react';
    import {MenuBarExtra, environment, launchCommand} from '@raycast/api';
    export default function Command() { const [count,setCount] = useState(0);
      return <MenuBarExtra title={String(count)} tooltip={environment.launchType}>
        <MenuBarExtra.Section title="Counter"><MenuBarExtra.Submenu title="Actions">
          <MenuBarExtra.Item title="Increment" onAction={() => setCount(count+1)}/>
          <MenuBarExtra.Separator/><MenuBarExtra.Item title="Launch" onAction={() => launchCommand({name:'other',type:'background',context:{count}})}/>
        </MenuBarExtra.Submenu></MenuBarExtra.Section>
      </MenuBarExtra>; }`);
  const first = await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'MenuBarExtra'));
  const action = nodes(first.tree).find(n => n.props.title === 'Increment');
  host.send({type:'event', callback:action.props.onAction.$callback,args:[{type:'left-click'}]});
  const second = await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'MenuBarExtra' && n.props.title === '1'));
  const launch = nodes(second.tree).find(n => n.props.title === 'Launch');
  host.send({type:'event',callback:launch.props.onAction.$callback});
  const request = await host.wait(m => m.type === 'launch-command');
  assert.equal(request.launchType,'background'); assert.deepEqual(request.launchContext,{count:1});
  host.send({type:'launch',extension:host.extension,command:'command',launchType:'background'});
  await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'MenuBarExtra' && n.props.tooltip === 'background' && n.props.title === '0'));
});
