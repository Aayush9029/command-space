import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import {once} from "node:events";
import { hasErrorCode, inputMessage, isRecord, outputMessage, renderTree, type InputMessage, type LaunchMessage, type RenderNode, type Values, type WireMessage } from "../protocol.ts";

const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface FixtureMetadata extends Values {
  command?: Values;
  launch?: Pick<LaunchMessage, "launchType" | "scheduled" | "openPreferences" | "setupComplete" | "preferences" | "arguments" | "launchContext" | "fallbackText">;
}

type MessagePredicate = (message: WireMessage) => boolean;

function parseRecord(text: string): Values {
  const value: unknown = JSON.parse(text);
  return record(value);
}

function record(value: unknown): Values {
  assert.ok(isRecord(value), `Expected an object: ${JSON.stringify(value)}`);
  return value;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function callbackId(value: unknown): string {
  return string(record(value).$callback);
}

function root(message: WireMessage): RenderNode {
  const node = renderTree(message.tree)[0];
  assert.ok(node, "Expected a root render node");
  return node;
}

function findNode(tree: unknown, predicate: (node: RenderNode) => boolean): RenderNode {
  const node = nodes(tree).find(predicate);
  assert.ok(node, "Expected a matching render node");
  return node;
}

async function fixture(t: TestContext, mode: "view" | "no-view" | "menu-bar", source: string, metadata: FixtureMetadata = {}) {
  const {command: definition, launch: launchOptions, ...manifestFields} = metadata;
  const home = await mkdtemp(path.join(tmpdir(), "super-space-extension-"));
  const extension = path.join(home, "fixture");
  await mkdir(path.join(extension, "src"), { recursive: true });
  await writeFile(path.join(extension, "package.json"), JSON.stringify({ name: "fixture", ...manifestFields, commands: [{ name: "command", title: "Fixture", mode, ...definition }] }));
  await writeFile(path.join(extension, "src/command.tsx"), source);
  await mkdir(path.join(home, "bin"));
  await writeFile(path.join(home, "bin/xdg-open"), "#!/bin/sh\nexit 0\n", {mode:0o755});
  const process = spawn(globalThis.process.execPath, [path.join(runtime, "host.ts")], { env: { ...globalThis.process.env, HOME: home, SUPER_SPACE_TOKEN_STORAGE:"file", PATH:`${home}/bin:${globalThis.process.env.PATH}`, XDG_DATA_HOME: path.join(home, "data") } });
  const messages: WireMessage[] = [];
  let stderr = "";
  const lines = readline.createInterface({ input: process.stdout });
  lines.on("line", line => messages.push(outputMessage(parseRecord(line))));
  process.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-64 * 1024); });
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      const closed = once(process,"close");
      process.kill();
      await closed;
    }
    await rm(home, { recursive: true, force: true });
  });
  const send = (value: InputMessage) => process.stdin.write(`${JSON.stringify(inputMessage(value))}\n`);
  async function wait(predicate: MessagePredicate, options: { allowErrors?: boolean; timeoutMs?: number } = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    while (Date.now() < deadline) {
      const error = messages.find(message => message.type === "error");
      if (error && !options.allowErrors) throw new Error(String(error.message));
      const result = messages.find(predicate);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Extension timed out: ${JSON.stringify(messages)} ${stderr}`);
  }
  send({ type: "launch", extension, command: "command", ...launchOptions });
  return { home, extension, send, wait, messages, process, sendRaw: (text: string) => process.stdin.write(text) };
}

test("rapid field events use the current React callback and acknowledge the latest edit", async t => {
  const host = await fixture(t, "view", `import { useState } from 'react'; import { Form } from '@raycast/api';
    export default function Command() { const [value,setValue] = useState(''); return <Form><Form.TextArea id="input" value={value} onChange={setValue}/></Form>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.id === "input"));
  const callback = callbackId(findNode(first.tree, n => n.props.id === "input").props.onChange);
  for (let index = 1; index <= 100; index++) host.send({type:"event",callback,field:"input",inputRevision:index,args:["a".repeat(index)]});
  const last = await host.wait(m => m.type === "render" && m.inputRevision === 100);
  assert.equal(findNode(last.tree, n => n.props.id === "input").props.value, "a".repeat(100));
});

test("pagination callbacks append pages and stop when exhausted", async t => {
  const host = await fixture(t, "view", `import {useState} from 'react'; import {List} from '@raycast/api';
    export default function Command() { const [page,setPage]=useState(1); const [loading,setLoading]=useState(false);
      return <List isLoading={loading} pagination={{hasMore:page<3,pageSize:2,onLoadMore:async()=>{setLoading(true); await new Promise(r=>setTimeout(r,20));setPage(page+1);setLoading(false);}}}>
        {Array.from({length:page*2},(_,i)=><List.Item key={i} id={String(i)} title={String(i)}/>)}</List>; }`);
  let render = await host.wait(m => m.type === "render" && renderTree(m.tree)[0]?.children.length === 2);
  for (const count of [4,6]) {
    assert.equal(record(root(render).props.pagination).hasMore,true);
    host.send({type:"event",callback:callbackId(record(root(render).props.pagination).onLoadMore),args:[]});
    render = await host.wait(m => m.type === "render" && renderTree(m.tree)[0]?.children.length === count && !root(m).props.isLoading);
  }
  assert.equal(record(root(render).props.pagination).hasMore,false);
  assert.equal(record(root(render).props.pagination).pageSize,2);
});

test("OAuth browser failure cancels the pending callback request", async t => {
  const host = await fixture(t, "no-view", `import { OAuth, LocalStorage } from '@raycast/api';
    export default async function Command() { const client = new OAuth.PKCEClient({providerName:'Fixture'});
      const request = await client.authorizationRequest({endpoint:'https://provider.example/authorize',clientId:'fixture'});
      try { await client.authorize(request); } catch (error) { await LocalStorage.setItem('error',error.message); } }`);
  const consent = await host.wait(m => m.type === "request" && m.kind === "confirm");
  await writeFile(path.join(host.home,"bin/xdg-open"), "#!/bin/sh\nexit 1\n", {mode:0o755});
  host.send({type:"response",id:string(consent.id),value:true});
  await host.wait(m => m.type === "cancel-request");
  await host.wait(m => m.type === "done");
  const saved = parseRecord(await readFile(path.join(host.home,"data/super-space/extension-data/fixture/storage.json"),"utf8"));
  assert.match(string(saved.error),/Could not open/);
});

function nodes(tree: unknown): RenderNode[] {
  const visit = (node: RenderNode): RenderNode[] => [node, ...node.children.flatMap(visit)];
  return renderTree(tree).flatMap(visit);
}

test("no-view confirmations keep reading responses while the command waits", async t => {
  const host = await fixture(t, "no-view", `import { confirmAlert, LocalStorage } from '@raycast/api';
    export default async function Command() { await LocalStorage.setItem('confirmed', await confirmAlert({ title: 'Continue?' })); }`);
  const request = await host.wait(message => message.type === "request" && message.kind === "confirm");
  host.send({ type: "response", id: string(request.id), value: true });
  await host.wait(message => message.type === "done");
  const saved = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/storage.json"), "utf8"));
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
  const action = findNode(first.tree, node => node.type === "Action");
  host.send({ type: "event", callback: callbackId(action.props.onAction), args: [] });
  const request = await host.wait(message => message.type === "request");
  host.send({ type: "response", id: string(request.id), value: false });
  await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.title === "Canceled"));
});

test("desktop application launches use a separate process group from their extension", async t => {
  const host = await fixture(t, "view", `import {useState} from 'react'; import {List,Action,ActionPanel,open,LocalStorage} from '@raycast/api';
    import {execFileSync} from 'node:child_process';import {readFile} from 'node:fs/promises';
    export default function Command() { const [title,setTitle]=useState('Open'); return <List><List.Item title={title} actions={<ActionPanel>
      <Action title="Open" onAction={async()=>{await open('https://fixture.invalid');await LocalStorage.setItem('groups',{worker:execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim(),application:(await readFile(process.env.HOME+'/open-group','utf8')).trim()});setTitle('Opened');}}/>
    </ActionPanel>}/></List>; }`);
  await writeFile(path.join(host.home,'bin/xdg-open'),'#!/bin/sh\nps -o pgid= -p "$$" > "$HOME/open-group"\n',{mode:0o755});
  const first = await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'Action'));
  host.send({type:'event',callback:callbackId(findNode(first.tree, n=>n.type==='Action').props.onAction),args:[]});
  await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.props.title === 'Opened'));
  const saved = parseRecord(await readFile(path.join(host.home,'data/super-space/extension-data/fixture/storage.json'),'utf8'));
  assert.match(string(record(saved.groups).worker),/^\d+$/);
  assert.match(string(record(saved.groups).application),/^\d+$/);
  assert.notEqual(record(saved.groups).application,record(saved.groups).worker);
});

test("TypeScript no-view commands use real persistent storage and toasts", async t => {
  const host = await fixture(t, "no-view", `import { LocalStorage, showHUD } from '@raycast/api';
    export default async function Command() { await LocalStorage.setItem('answer', 42); await showHUD('Saved'); }`);
  await host.wait(message => message.type === "done");
  const saved = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/storage.json"), "utf8"));
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
  const list = findNode(first.tree, node => node.type === "List");
  assert.ok(callbackId(list.props.onSearchTextChange));
  host.send({ type: "event", callback: callbackId(list.props.onSearchTextChange), args: ["changed"] });
  const changed = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item" && node.props.title === "changed"));
  const action = findNode(changed.tree, node => node.type === "Action");
  host.send({ type: "event", callback: callbackId(action.props.onAction), args: [] });
  const updated = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item" && node.props.subtitle === "1"));
  assert.ok(updated);
});


test("command arguments render a form, validate required values, and reach the command", async t => {
  const host = await fixture(t, "no-view", `import { LocalStorage } from '@raycast/api';
    export default async function Command(props) { await LocalStorage.setItem('arguments', props.arguments); }`,
    { command: { arguments: [{ name: 'topic', type: 'text', required: true, placeholder: 'Topic' }] } });
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Form.TextField"));
  const action = findNode(first.tree, node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: callbackId(action.props.onAction), args: [{ topic: "" }] });
  const invalid = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.error === "This field is required"));
  const submit = findNode(invalid.tree, node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: callbackId(submit.props.onAction), args: [{ topic: "Omarchy" }] });
  await host.wait(message => message.type === "done");
  const saved = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/storage.json"), "utf8"));
  assert.deepEqual(saved.arguments, { topic: "Omarchy" });
});

test("partially supplied launch arguments retain values while requesting missing required input", async t => {
  const host = await fixture(t, "no-view", `import {LocalStorage} from '@raycast/api';
    export default async function Command(props) { await LocalStorage.setItem('arguments',props.arguments); }`, {
    command:{arguments:[{name:'topic',type:'text',required:true},{name:'scope',type:'text',required:true}]},
    launch:{arguments:{topic:'Omarchy'}},
  });
  const first = await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'Form.TextField'));
  assert.equal(findNode(first.tree, n => n.props.id === 'topic').props.defaultValue,'Omarchy');
  const submit = findNode(first.tree, n => n.type === 'Action.SubmitForm');
  host.send({type:'event',callback:callbackId(submit.props.onAction),args:[{topic:'Omarchy',scope:'Linux'}]});
  await host.wait(m => m.type === 'done');
  const saved = parseRecord(await readFile(path.join(host.home,'data/super-space/extension-data/fixture/storage.json'),'utf8'));
  assert.deepEqual(saved.arguments,{topic:'Omarchy',scope:'Linux'});
});

test("programmatic commands preserve launch type, arguments, fallback text, owner, and typed context", async t => {
  const host = await fixture(t, "no-view", `import {launchCommand,LocalStorage,environment,LaunchType} from '@raycast/api';
    export default async function Command(props) {
      if (!props.launchContext) { await launchCommand({name:'command',type:LaunchType.Background,arguments:{topic:'Omarchy'},fallbackText:'find this',context:{at:new Date('2026-09-09T12:00:00Z'),nested:[Buffer.from('Linux')],literal:{type:'Buffer',data:[1,2]}}}); return; }
      await LocalStorage.setItem('launch',{arguments:props.arguments,launchType:props.launchType,environmentType:environment.launchType,owner:environment.ownerOrAuthorName,fallback:props.fallbackText,date:props.launchContext.at instanceof Date,iso:props.launchContext.at.toISOString(),buffer:Buffer.isBuffer(props.launchContext.nested[0]),text:props.launchContext.nested[0].toString(),literal:props.launchContext.literal});
    }`, {author:'fixture-author',owner:'fixture-owner'});
  const event = await host.wait(m => m.type === 'launch-command');
  assert.equal(event.extensionName,'fixture');
  await host.wait(m => m.type === 'done');
  host.send({...event,type:'launch',extension:host.extension,command:string(event.name)});
  await host.wait(m => m.type === 'done' && host.messages.filter(m => m.type === 'done').length === 2);
  const saved = parseRecord(await readFile(path.join(host.home,'data/super-space/extension-data/fixture/storage.json'),'utf8'));
  assert.deepEqual(saved.launch,{arguments:{topic:'Omarchy'},launchType:'background',environmentType:'background',owner:'fixture-owner',fallback:'find this',date:true,iso:'2026-09-09T12:00:00.000Z',buffer:true,text:'Linux',literal:{type:'Buffer',data:[1,2]}});
});

test("launchCommand rejects missing commands, mismatched owners, invalid types, and cyclic contexts", async t => {
  const host = await fixture(t, "no-view", `import {launchCommand,LocalStorage} from '@raycast/api';
    export default async function Command() { const cyclic={};cyclic.self=cyclic;const errors=[];
      for (const options of [{name:'missing'},{name:'command',extensionName:'missing'},{name:'command',ownerOrAuthorName:'different'},{name:'command',type:'invalid'},{name:'command',context:cyclic}]) {
        try { await launchCommand(options);errors.push('unexpected success'); } catch(error) { errors.push(error.message); }
      } await LocalStorage.setItem('errors',errors);
    }`, {author:'fixture-author'});
  await host.wait(m => m.type === 'done');
  const saved = parseRecord(await readFile(path.join(host.home,'data/super-space/extension-data/fixture/storage.json'),'utf8'));
  assert.match(string(array(saved.errors)[0]),/not installed/);
  assert.match(string(array(saved.errors)[1]),/not installed/);
  assert.match(string(array(saved.errors)[2]),/different owner/);
  assert.match(string(array(saved.errors)[3]),/Invalid command launch type/);
  assert.match(string(array(saved.errors)[4]),/JSON serializable/);
  assert.equal(host.messages.filter(m => m.type === 'launch-command').length,0);
});

test("background refreshes skip optional argument setup and execute serially with fresh module state", async t => {
  const host = await fixture(t, "no-view", `import {LocalStorage} from '@raycast/api';
    let moduleRuns=0;
    export default async function Command(props) { const runs=await LocalStorage.getItem('runs')||[];
      await new Promise(resolve=>setTimeout(resolve,30));
      runs.push({id:props.launchContext?.id||0,moduleRuns:++moduleRuns,type:props.launchType,arguments:props.arguments});await LocalStorage.setItem('runs',runs);
    }`, {command:{arguments:[{name:'optional',type:'text',required:false}]},launch:{launchType:'background'}});
  for (const id of [1,2,3]) host.send({type:'launch',extension:host.extension,command:'command',launchType:'background',launchContext:{id}});
  await host.wait(m => m.type === 'done' && host.messages.filter(m => m.type === 'done').length === 4);
  const saved = parseRecord(await readFile(path.join(host.home,'data/super-space/extension-data/fixture/storage.json'),'utf8'));
  assert.deepEqual(saved.runs,[0,1,2,3].map(id=>({id,moduleRuns:1,type:'background',arguments:{}})));
  assert.equal(host.messages.filter(m => m.type === 'render').length,0);
});

async function processAlive(pid: unknown): Promise<boolean> {
  assert.ok(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
  try { return !/\) Z /.test(await readFile(`/proc/${pid}/stat`,'utf8')); }
  catch(error) { if (hasErrorCode(error, 'ENOENT')) return false; throw error; }
}

test("completed background invocations discard unmanaged timers and subprocesses before a second launch", async t => {
  const host = await fixture(t, 'no-view', `import {LocalStorage} from '@raycast/api';import fs from 'node:fs';import {spawn} from 'node:child_process';
    export default async function Command(props) { const run=props.launchContext?.run||'first';
      const child=spawn('sleep',['60'],{stdio:'ignore'});const file=process.env.HOME+'/ticks';
      setInterval(()=>fs.appendFileSync(file,run+'\\n'),10);
      await new Promise(resolve=>setTimeout(resolve,45));
      const runs=await LocalStorage.getItem('runs')||[];runs.push({run,pid:process.pid,child:child.pid});await LocalStorage.setItem('runs',runs);
    }`, {launch:{launchType:'background'}});
  const storage = path.join(host.home,'data/super-space/extension-data/fixture/storage.json');
  await host.wait(m => m.type === 'done');
  const first = record(array(parseRecord(await readFile(storage,'utf8')).runs)[0]);
  const ticks = await readFile(path.join(host.home,'ticks'),'utf8');
  assert.ok(ticks.includes('first'));
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(await readFile(path.join(host.home,'ticks'),'utf8'),ticks);
  assert.equal(await processAlive(record(first).pid),false);
  assert.equal(await processAlive(record(first).child),false);
  host.send({type:'launch',extension:host.extension,command:'command',launchType:'background',launchContext:{run:'second'}});
  await host.wait(m => m.type === 'done' && host.messages.filter(m=>m.type==='done').length===2);
  const runs = array(parseRecord(await readFile(storage,'utf8')).runs).map(record);
  assert.deepEqual(runs.map(run=>run.run),['first','second']);
  assert.notEqual(runs[0].pid,runs[1].pid);
  assert.equal(await processAlive(runs[1].pid),false);
  assert.equal(await processAlive(runs[1].child),false);
});

test("a scheduled refresh replaces an unresponsive background invocation without blocking the host", async t => {
  const host = await fixture(t,'no-view',`import {LocalStorage,showHUD} from '@raycast/api';import {spawn} from 'node:child_process';
    export default async function Command(props) {
      if (props.launchContext?.second) {await LocalStorage.setItem('recovered',true);return;}
      const child=spawn('sleep',['60'],{stdio:'ignore'});await LocalStorage.setItem('first',{pid:process.pid,child:child.pid});await showHUD('Background started');while(true){}
    }`,{launch:{launchType:'background'}});
  await host.wait(m=>m.type==='toast' && m.title==='Background started');
  const file = path.join(host.home,'data/super-space/extension-data/fixture/storage.json');
  const {first} = parseRecord(await readFile(file,'utf8'));
  host.send({type:'launch',extension:host.extension,command:'command',launchType:'background',scheduled:true,launchContext:{second:true}});
  await host.wait(m=>m.type==='done');
  assert.equal(parseRecord(await readFile(file,'utf8')).recovered,true);
  assert.equal(await processAlive(record(first).pid),false);
  assert.equal(await processAlive(record(first).child),false);
});

test("menu refreshes isolate old timers and children while preserving live actions and ignoring obsolete callbacks", async t => {
  const host = await fixture(t, 'menu-bar', `import {useEffect,useState} from 'react';import {MenuBarExtra} from '@raycast/api';import fs from 'node:fs';import {spawn} from 'node:child_process';
    export default function Command(props) {const run=props.launchContext?.run||'first';const [ready,setReady]=useState(false);const [count,setCount]=useState(0);
      useEffect(()=>{const child=spawn('sleep',['60'],{stdio:'ignore'});fs.writeFileSync(process.env.HOME+'/'+run,String(child.pid));setInterval(()=>{fs.appendFileSync(process.env.HOME+'/ticks',run+'\\n');setReady(true);},10);},[]);
      return <MenuBarExtra title={ready?run+':'+count:'Loading'}><MenuBarExtra.Item title="Increment" onAction={()=>setCount(count+1)}/></MenuBarExtra>;}
    `);
  const first = await host.wait(m=>m.type==='render' && nodes(m.tree).some(n=>n.props.title==='first:0'));
  const oldCallback = callbackId(findNode(first.tree, n=>n.props.title==='Increment').props.onAction);
  const firstChild = Number(await readFile(path.join(host.home,'first'),'utf8'));
  assert.equal(await processAlive(firstChild),true);
  host.send({type:'launch',extension:host.extension,command:'command',launchType:'background',launchContext:{run:'second'}});
  const second = await host.wait(m=>m.type==='render' && nodes(m.tree).some(n=>n.props.title==='second:0'));
  assert.notEqual(root(first).id,root(second).id);
  assert.equal(await processAlive(firstChild),false);
  const firstTicks = (await readFile(path.join(host.home,'ticks'),'utf8')).split('\n').filter(line=>line==='first').length;
  host.send({type:'event',callback:oldCallback,args:[]});
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal((await readFile(path.join(host.home,'ticks'),'utf8')).split('\n').filter(line=>line==='first').length,firstTicks);
  assert.equal(host.messages.some(m=>m.type==='render' && nodes(m.tree).some(n=>n.props.title==='second:1')),false);
  host.send({type:'event',callback:callbackId(findNode(second.tree, n=>n.props.title==='Increment').props.onAction),args:[]});
  await host.wait(m=>m.type==='render' && nodes(m.tree).some(n=>n.props.title==='second:1'));
});

test("required preferences persist and are available when the command runs", async t => {
  const host = await fixture(t, "no-view", `import { LocalStorage, getPreferenceValues } from '@raycast/api';
    export default async function Command() { await LocalStorage.setItem('configured', getPreferenceValues().endpoint); }`,
    { preferences: [{ name: 'endpoint', type: 'textfield', title: 'Endpoint', required: true }] });
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Form.TextField"));
  const submit = findNode(first.tree, node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: callbackId(submit.props.onAction), args: [{ endpoint: "https://example.test" }] });
  await host.wait(message => message.type === "done");
  const saved = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/preferences.json"), "utf8"));
  assert.equal(record(saved.extension).endpoint, "https://example.test");
  const storage = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/storage.json"), "utf8"));
  assert.equal(storage.configured, "https://example.test");
});

test("two open command preference forms preserve each other's saved settings", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "super-space-preferences-"));
  const extension = path.join(home, "fixture"), children: ChildProcessWithoutNullStreams[] = [];
  await mkdir(path.join(extension, "src"), {recursive: true});
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close"); child.kill(); await closed;
      }
    }
    await rm(home, {recursive: true, force: true});
  });
  const commands = ["first", "second"].map(name => ({name, title:name, mode:"no-view",
    preferences:[{name:"own", title:"Own", type:"textfield", required:true}]}));
  await writeFile(path.join(extension, "package.json"), JSON.stringify({name:"fixture", commands}));
  for (const command of commands) await writeFile(path.join(extension, "src", `${command.name}.ts`),
    `import {LocalStorage,getPreferenceValues} from '@raycast/api'; export default async function Command() { await LocalStorage.setItem('${command.name}',getPreferenceValues().own); }`);
  async function launch(command: string) {
    const child = spawn(process.execPath, [path.join(runtime, "host.ts")], {env:{...process.env, HOME:home, XDG_DATA_HOME:path.join(home, "data")}});
    children.push(child);
    const messages: WireMessage[] = [];
    let stderr = "";
    readline.createInterface({input:child.stdout}).on("line", line => messages.push(outputMessage(parseRecord(line))));
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-64 * 1024); });
    const send = (message: InputMessage) => child.stdin.write(`${JSON.stringify(inputMessage(message))}\n`);
    async function wait(predicate: MessagePredicate) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const error = messages.find(message => message.type === "error");
        if (error) throw new Error(String(error.message));
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Preferences timed out: ${JSON.stringify(messages)} ${stderr}`);
    }
    send({type:"launch", extension, command, openPreferences:true});
    const rendered = await wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
    return {send, wait, callback:callbackId(findNode(rendered.tree, node => node.type === "Action.SubmitForm").props.onAction)};
  }
  const first = await launch("first"), second = await launch("second");
  first.send({type:"event", callback:first.callback, args:[{own:"first-value"}]});
  await first.wait(message => message.type === "done");
  second.send({type:"event", callback:second.callback, args:[{own:"second-value"}]});
  await second.wait(message => message.type === "done");
  const directory = path.join(home, "data/super-space/extension-data/fixture");
  assert.deepEqual(parseRecord(await readFile(path.join(directory, "preferences.json"), "utf8")),
    {extension:{}, commands:{first:{own:"first-value"}, second:{own:"second-value"}}});
  assert.deepEqual(parseRecord(await readFile(path.join(directory, "storage.json"), "utf8")), {first:"first-value", second:"second-value"});
});

test("date picker values arrive as Date objects in form submission", async t => {
  const host = await fixture(t, "view", `import { Form, Action, ActionPanel, LocalStorage } from '@raycast/api';
    export default function Command() {
      return <Form actions={<ActionPanel><Action.SubmitForm onSubmit={async values => { await LocalStorage.setItem('date', values.date.toISOString()); }}/></ActionPanel>}><Form.DatePicker id="date" title="Date"/></Form>;
    }`);
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  const action = findNode(first.tree, node => node.type === "Action.SubmitForm");
  host.send({ type: "event", callback: callbackId(action.props.onAction), args: [{ date: "2026-09-09T12:00:00Z" }] });
  const file = path.join(host.home, "data/super-space/extension-data/fixture/storage.json");
  let saved: Values | undefined;
  for (let i = 0; i < 50; i++) { try { saved = parseRecord(await readFile(file, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  assert.ok(saved);
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
  const saved = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/storage.json"), "utf8"));
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
  host.send({ type:"event", callback:callbackId(findNode(first.tree, n => n.props.title === "Increment").props.onAction) });
  const updated = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.type === "List.Item" && n.props.title === "1"));
  host.send({ type:"event", callback:callbackId(findNode(updated.tree, n => n.props.title === "Next").props.onAction) });
  await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.markdown === "Second page"));
  host.send({ type:"pop" });
  const returned = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.subtitle === "returned"));
  assert.equal(findNode(returned.tree, n => n.type === "List.Item").props.title, "1");
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
  host.send({ type:"event", callback:callbackId(findNode(first.tree, n => n.props.title === "Reset").props.onAction) });
  await host.wait(m => m.type === "field-command" && m.operation === "focus");
  const reset = await host.wait(m => m.type === "field-command" && m.operation === "reset");
  assert.equal(reset.id, "name");
  assert.equal(reset.value, "initial");
});

test("stored form values survive submission but exclude abandoned and rejected edits", async t => {
  const host = await fixture(t,"view", `import { Form, Action, ActionPanel } from '@raycast/api';
    export default function Command() { return <Form actions={<ActionPanel><Action.SubmitForm onSubmit={values => values.remembered !== 'invalid'}/></ActionPanel>}><Form.TextField id="remembered" storeValue defaultValue="first"/><Form.TextField id="temporary"/></Form>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.id === "remembered"));
  const action = findNode(first.tree, n => n.type === "Action.SubmitForm");
  const file = path.join(host.home,"data/super-space/extension-data/fixture/form-values.json");
  await assert.rejects(stat(file), {code:"ENOENT"});
  host.send({type:"event",callback:callbackId(action.props.onAction),args:[{remembered:"invalid"}]});
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(stat(file), {code:"ENOENT"});
  host.send({type:"event",callback:callbackId(action.props.onAction),args:[{remembered:"restored value",temporary:"do not store"}]});
  let saved: Values | undefined;
  for (let i=0;i<100;i++) { try {saved=parseRecord(await readFile(file,"utf8"));break;} catch {await new Promise(resolve => setTimeout(resolve,10));} }
  assert.ok(saved);
  assert.deepEqual(saved.command,{remembered:"restored value"});
  host.send({type:"launch",extension:host.extension,command:"command"});
  await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.defaultValue === "restored value"));
});

test("search dropdowns restore their saved selection across launches", async t => {
  const host = await fixture(t,"view", `import {List} from '@raycast/api';
    export default function Command() { return <List searchBarAccessory={<List.Dropdown storeValue defaultValue="one"><List.Dropdown.Item title="One" value="one"/><List.Dropdown.Item title="Two" value="two"/></List.Dropdown>}/>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.type === "List.Dropdown"));
  const dropdown = findNode(first.tree, n => n.type === "List.Dropdown");
  host.send({type:"event",callback:callbackId(dropdown.props.onChange),args:["two"]});
  const file = path.join(host.home,"data/super-space/extension-data/fixture/dropdown-values.json");
  for (let index=0;index<100;index++) { try { await stat(file); break; } catch { await new Promise(resolve=>setTimeout(resolve,10)); } }
  assert.deepEqual(parseRecord(await readFile(file,"utf8")), {command:{search:"two"}});
  host.send({type:"launch",extension:host.extension,command:"command"});
  await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.type === "List.Dropdown" && n.props.defaultValue === "two"));
});

test("date focus events restore Date values and non-text refs reach the native field", async t => {
  const host = await fixture(t,"view", `import {useRef} from 'react'; import {Form,Action,ActionPanel,LocalStorage} from '@raycast/api';
    export default function Command() { const field = useRef(null); return <Form actions={<ActionPanel><Action title="Focus checkbox" onAction={() => field.current.focus()}/></ActionPanel>}>
      <Form.DatePicker id="date" onFocus={event => LocalStorage.setItem('focus',{type:event.type,id:event.target.id,date:event.target.value.toISOString()})} onBlur={event => LocalStorage.setItem('blur',event.target.value)}/>
      <Form.Checkbox id="enabled" ref={field} label="Enabled"/>
    </Form>; }`);
  const first = await host.wait(m => m.type === "render" && nodes(m.tree).some(n => n.props.id === "date"));
  const date = findNode(first.tree, n => n.props.id === "date");
  host.send({type:"event",callback:callbackId(date.props.onFocus),args:[{type:"focus",target:{id:"date",value:"2026-09-17T12:00:00Z"}}]});
  host.send({type:"event",callback:callbackId(date.props.onBlur),args:[{type:"blur",target:{id:"date",value:null}}]});
  const action = findNode(first.tree, n => n.props.title === "Focus checkbox");
  host.send({type:"event",callback:callbackId(action.props.onAction)});
  const focus = await host.wait(m => m.type === "field-command");
  assert.deepEqual(focus,{type:"field-command",operation:"focus",id:"enabled"});
  const saved = parseRecord(await readFile(path.join(host.home,"data/super-space/extension-data/fixture/storage.json"),"utf8"));
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
  host.send({type:"response",id:string(consent.id),value:true});
  const authorization = await host.wait(m => m.type === "request" && m.kind === "oauth");
  host.send({type:"response",id:string(authorization.id),value:`raycast://oauth?code=fixture-code&state=${string(record(authorization.options).state)}`});
  await host.wait(m => m.type === "done");
  const folder = path.join(host.home,"data/super-space/extension-data/fixture");
  const saved = parseRecord(await readFile(path.join(folder,"storage.json"),"utf8"));
  assert.equal(createHash("sha256").update(string(record(saved.request).verifier)).digest("base64url"), record(saved.request).challenge);
  assert.equal(new URL(string(record(saved.request).url)).searchParams.get("prompt"),"consent");
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
  host.send({type:"response",id:string(consent.id),value:true});
  const authorization = await host.wait(m => m.type === "request" && m.kind === "oauth");
  host.send({type:"response",id:string(authorization.id),value:"raycast://oauth?code=wrong-code&state=unrelated"});
  await host.wait(m => m.type === "done");
  const saved = parseRecord(await readFile(path.join(host.home,"data/super-space/extension-data/fixture/storage.json"),"utf8"));
  assert.match(string(saved.error),/state did not match/);
});


test("menu-bar commands retain React state, nested callbacks, and background launch context", async t => {
  const host = await fixture(t, "menu-bar", `import {useState} from 'react';
    import {MenuBarExtra, environment, launchCommand} from '@raycast/api';
    export default function Command() { const [count,setCount] = useState(0);
      return <MenuBarExtra title={String(count)} tooltip={environment.launchType}>
        <MenuBarExtra.Section title="Counter"><MenuBarExtra.Submenu title="Actions">
          <MenuBarExtra.Item title="Increment" onAction={() => setCount(count+1)}/>
          <MenuBarExtra.Separator/><MenuBarExtra.Item title="Launch" onAction={() => launchCommand({name:'command',type:'background',context:{count}})}/>
        </MenuBarExtra.Submenu></MenuBarExtra.Section>
      </MenuBarExtra>; }`);
  const first = await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'MenuBarExtra'));
  const action = findNode(first.tree, n => n.props.title === 'Increment');
  host.send({type:'event', callback:callbackId(action.props.onAction),args:[{type:'left-click'}]});
  const second = await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'MenuBarExtra' && n.props.title === '1'));
  const launch = findNode(second.tree, n => n.props.title === 'Launch');
  host.send({type:'event',callback:callbackId(launch.props.onAction)});
  const request = await host.wait(m => m.type === 'launch-command');
  assert.equal(request.launchType,'background'); assert.deepEqual(request.launchContext,{count:1});
  host.send({type:'launch',extension:host.extension,command:'command',launchType:'background'});
  await host.wait(m => m.type === 'render' && nodes(m.tree).some(n => n.type === 'MenuBarExtra' && n.props.tooltip === 'background' && n.props.title === '0'));
});


test("malformed host messages report errors without interrupting current callbacks", async t => {
  const host = await fixture(t, "view", `import {useState} from 'react'; import {List,Action,ActionPanel} from '@raycast/api';
    export default function Command() {const [count,setCount]=useState(0);return <List><List.Item title={String(count)} actions={<ActionPanel><Action title="Increment" onAction={()=>setCount(value=>value+1)}/></ActionPanel>}/></List>;}`);
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.title === "Increment"));
  const action = callbackId(findNode(first.tree, node => node.props.title === "Increment").props.onAction);
  const malformed = [
    "{invalid JSON",
    JSON.stringify(null),
    JSON.stringify({type:"launch", extension:host.extension}),
    JSON.stringify({type:"event", callback:action, args:{value:1}}),
    JSON.stringify({type:"event", callback:action, inputRevision:-1}),
    JSON.stringify({type:"response", id:3}),
    JSON.stringify({type:"unknown"}),
  ];
  host.sendRaw(malformed.join("\n") + "\n");
  await host.wait(message => message.type === "error" && host.messages.filter(item => item.type === "error").length === malformed.length, {allowErrors:true});
  host.send({type:"event", callback:action, args:[]});
  await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item" && node.props.title === "1"), {allowErrors:true});
});

test("an oversized input frame stops its invocation and unmanaged subprocesses", async t => {
  const host = await fixture(t, "no-view", `import {LocalStorage,showHUD} from '@raycast/api';import {spawn} from 'node:child_process';
    export default async function Command() {const child=spawn('sleep',['60'],{stdio:'ignore'});await LocalStorage.setItem('worker',{pid:process.pid,child:child.pid});await showHUD('Running');await new Promise(()=>{});}`);
  await host.wait(message => message.type === "toast" && message.title === "Running");
  const stored = parseRecord(await readFile(path.join(host.home, "data/super-space/extension-data/fixture/storage.json"), "utf8"));
  const worker = record(stored.worker);
  const closed = once(host.process, "close", {signal:AbortSignal.timeout(5000)});
  host.sendRaw(" ".repeat(1024 * 1024 + 1));
  await closed;
  assert.equal(host.process.exitCode, 0);
  const error = host.messages.find(message => message.type === "error");
  assert.ok(error);
  assert.match(string(error.message), /protocol line exceeds/);
  assert.equal(await processAlive(worker.pid), false);
  assert.equal(await processAlive(worker.child), false);
});

test("an oversized worker frame releases the invocation and advances queued launches", async t => {
  const host = await fixture(t, "no-view", `
    export default async function Command(props) {
      if(props.launchContext?.run === 'second') {process.stdout.write(JSON.stringify({type:'toast',title:'Recovered'})+'\\n');return;}
      process.stdout.write(JSON.stringify({type:'toast',title:'Producing output'})+'\\n');
      await new Promise(resolve=>setTimeout(resolve,100));
      process.stdout.write('x'.repeat(16*1024*1024+1));
      await new Promise(()=>{});
    }`);
  await host.wait(message => message.type === "toast" && message.title === "Producing output");
  const started = host.messages.find(message => message.type === "invocation-started");
  assert.ok(started);
  host.send({type:"launch", extension:host.extension, command:"command", launchContext:{run:"second"}});
  await host.wait(message => message.type === "error" && /protocol line exceeds/.test(string(message.message)), {allowErrors:true});
  await host.wait(message => message.type === "invocation-ended" && message.pid === started.pid, {allowErrors:true});
  await host.wait(message => message.type === "toast" && message.title === "Recovered", {allowErrors:true});
  await host.wait(message => message.type === "done", {allowErrors:true});
  assert.equal(await processAlive(started.pid), false);
  assert.equal(host.messages.filter(message => message.type === "invocation-started").length, 2);
});

test("queued launches are bounded while the active command waits", async t => {
  const host = await fixture(t, "no-view", `export default async function Command() {
    process.stdout.write(JSON.stringify({type:'toast',title:'Waiting'})+'\\n');await new Promise(()=>{});
  }`);
  await host.wait(message => message.type === "toast" && message.title === "Waiting");
  for (let index = 0; index < 65; index++) host.send({type:"launch",extension:host.extension,command:"command"});
  const error = await host.wait(message => message.type === "error", {allowErrors:true});
  assert.match(string(error.message), /Too many queued extension launches/);
  assert.equal(host.messages.filter(message => message.type === "invocation-started").length, 1);
  const closed = once(host.process, "close", {signal:AbortSignal.timeout(5000)});
  host.send({type:"stop"});
  await closed;
});

test("scheduled launches coalesce to the newest request behind a foreground invocation", async t => {
  const host = await fixture(t, "no-view", `import {confirmAlert} from '@raycast/api';
    export default async function Command(props) {
      if(!props.launchContext) await confirmAlert({title:'Hold foreground'});
      else process.stdout.write(JSON.stringify({type:'toast',title:String(props.launchContext.run)})+'\\n');
    }`);
  const request = await host.wait(message => message.type === "request" && message.kind === "confirm");
  for (let run = 1; run <= 70; run++) host.send({type:"launch",extension:host.extension,command:"command",launchType:"background",scheduled:true,launchContext:{run}});
  host.send({type:"response",id:string(request.id),value:true});
  await host.wait(message => message.type === "done" && host.messages.filter(item => item.type === "done").length === 2);
  assert.deepEqual(host.messages.filter(message => message.type === "toast").map(message => message.title), ["70"]);
  assert.equal(host.messages.filter(message => message.type === "invocation-started").length, 2);
});


async function hungInvocation(t: TestContext, background = false) {
  const host = await fixture(t, "no-view", `import {spawn} from 'node:child_process';import {writeFileSync,writeSync} from 'node:fs';
    export default async function Command(props) {
      if(props.launchContext?.run === 'second') {writeSync(1,JSON.stringify({type:'toast',title:'Recovered'})+'\\n');return;}
      const child=spawn('sleep',['60'],{stdio:'ignore'});
      writeFileSync(process.env.HOME+'/worker.json',JSON.stringify({pid:process.pid,child:child.pid}));
      writeSync(1,JSON.stringify({type:'render',tree:[{id:'hung',type:'Action',props:{title:'Hung',onAction:{$callback:'blocked'}},children:[]}]})+'\\n');
      while(true){}
    }`, {launch:{launchType:background ? "background" : "userInitiated"}});
  const rendered = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.title === "Hung"));
  const callback = callbackId(findNode(rendered.tree, node => node.props.title === "Hung").props.onAction);
  const worker = parseRecord(await readFile(path.join(host.home, "worker.json"), "utf8"));
  return {host, callback, worker};
}

test("stop remains responsive when a synchronously hung worker fills its input pipe", async t => {
  const {host, callback, worker} = await hungInvocation(t);
  const closed = once(host.process, "close", {signal:AbortSignal.timeout(2000)});
  const started = performance.now();
  const args = ["x".repeat(512 * 1024)];
  for (let index = 0; index < 6; index++) host.send({type:"event", callback, args});
  host.send({type:"stop"});
  await closed;
  assert.ok(performance.now() - started < 2000, "Stop must finish within two seconds");
  assert.equal(host.process.exitCode, 0);
  assert.equal(await processAlive(worker.pid), false);
  assert.equal(await processAlive(worker.child), false);
});

test("scheduled refresh remains responsive when a hung background worker fills its input pipe", async t => {
  const {host, callback, worker} = await hungInvocation(t, true);
  const started = performance.now();
  const args = ["x".repeat(512 * 1024)];
  for (let index = 0; index < 6; index++) host.send({type:"event", callback, args});
  host.send({type:"launch", extension:host.extension, command:"command", launchType:"background", scheduled:true, launchContext:{run:"second"}});
  await host.wait(message => message.type === "done", {timeoutMs:2000});
  assert.ok(performance.now() - started < 2000, "Scheduled refresh must finish within two seconds");
  assert.ok(host.messages.some(message => message.type === "toast" && message.title === "Recovered"));
  assert.equal(await processAlive(worker.pid), false);
  assert.equal(await processAlive(worker.child), false);
  assert.equal(host.messages.filter(message => message.type === "invocation-started").length, 2);
});

for (const limit of ["bytes", "messages"]) {
  test(`a hung worker exceeding the pending input ${limit} limit releases queued launches`, async t => {
    const {host, callback, worker} = await hungInvocation(t);
    host.send({type:"launch", extension:host.extension, command:"command", launchContext:{run:"second"}});
    const blockingMessages = limit === "bytes" ? 1 : 6;
    for (let index = 0; index < blockingMessages; index++) host.send({type:"event", callback, args:["x".repeat(512 * 1024)]});
    const count = limit === "bytes" ? 8 : 256;
    const args = limit === "bytes" ? ["x".repeat(512 * 1024)] : [];
    for (let index = 0; index < count; index++) host.send({type:"event", callback, args});
    const error = await host.wait(message => message.type === "error", {allowErrors:true});
    assert.match(string(error.message), /Extension invocation input backlog exceeded/);
    await host.wait(message => message.type === "done", {allowErrors:true});
    const ended = host.messages.findIndex(message => message.type === "invocation-ended" && message.pid === worker.pid);
    const recovered = host.messages.findIndex(message => message.type === "toast" && message.title === "Recovered");
    assert.ok(ended >= 0 && recovered > ended, "Recovery must follow termination of the blocked invocation");
    assert.equal(await processAlive(worker.pid), false);
    assert.equal(await processAlive(worker.child), false);
    assert.equal(host.messages.filter(message => message.type === "invocation-started").length, 2);
  });
}
