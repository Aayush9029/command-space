import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {WindowManagement, type WindowBounds} from "../windows.ts";

async function desktop(t: TestContext, overrides: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-windows-"));
  const prior = {PATH:process.env.PATH,SUPER_SPACE_FRONTMOST:process.env.SUPER_SPACE_FRONTMOST};
  const fixture = {
    activewindow:{stableId:"b2"},
    clients:[
      {stableId:"a1",class:"editor",title:"Editor",pid:123,mapped:true,monitor:2,workspace:{id:4,name:"work"},fullscreen:0,at:[-1600,100],size:[800,600]},
      {stableId:"b2",class:"browser",title:"Browser",mapped:true,monitor:0,workspace:{id:1,name:"1"},fullscreen:1,at:[0,30],size:[1920,1050]},
      {stableId:"c3",class:"super-space",mapped:true},
      {stableId:"d4",class:"closed",mapped:false},
    ],
    workspaces:[{id:1,name:"1",monitorID:0},{id:4,name:"work",monitorID:2},{id:-99,name:"special:scratchpad",monitorID:2},{id:9,name:"disconnected",monitorID:9}],
    monitors:[{id:0,name:"main",focused:true,width:1920,height:1080,scale:1,activeWorkspace:{id:1}},
      {id:2,name:"portrait",width:2160,height:3840,scale:1.5,transform:1,activeWorkspace:{id:4},specialWorkspace:{id:-99}}],
    ...overrides,
  };
  const data=path.join(directory,"data.json"),log=path.join(directory,"evals.jsonl");
  await fs.writeFile(data,JSON.stringify(fixture));
  await fs.writeFile(path.join(directory,"hyprctl"),`#!${process.execPath}\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="-j") process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(data)},"utf8"))[args[1]]));\nelse {fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args[1])+"\\n");process.stdout.write("ok\\n");}\n`,{mode:0o700});
  process.env.PATH=`${directory}:${prior.PATH}`;
  process.env.SUPER_SPACE_FRONTMOST=JSON.stringify({stableId:"a1",monitor:2});
  t.after(async()=>{
    for(const [key,value] of Object.entries(prior)) if(value===undefined) delete process.env[key]; else process.env[key]=value;
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {fixture,write:()=>fs.writeFile(data,JSON.stringify(fixture)),calls:async()=>{
    const content=await fs.readFile(log,"utf8").catch(()=>"");
    return content.trim()?content.trim().split("\n").map((line): string => JSON.parse(line)):[];
  }};
}

test("window API retains captured focus, filters launcher and distinguishes maximize from fullscreen",async t=>{
  const mock=await desktop(t);
  const {getActiveWindow}=WindowManagement;
  assert.equal((await getActiveWindow()).id,"a1");
  const windows=await WindowManagement.getWindows();
  assert.deepEqual(windows.map(window=>window.id),["a1","b2"]);
  assert.equal(typeof windows[1].bounds,"object");
  mock.fixture.clients[1].fullscreen=2;await mock.write();
  assert.equal((await WindowManagement.getWindows())[1].bounds,"fullscreen");
});

test("desktop API handles rotated scaled displays, named and special desktops, and disconnected outputs",async t=>{
  await desktop(t);
  const desktops=await WindowManagement.getDesktops();
  assert.deepEqual(desktops.map(desktop=>desktop.id),["-99","4","1"]);
  assert.deepEqual(desktops[0].size,{width:2560,height:1440});
  assert.ok(desktops.every(desktop=>desktop.active));
  assert.deepEqual((await WindowManagement.getWindowsOnActiveDesktop()).map(window=>window.id),["a1","b2"]);
});

test("partial window geometry preserves omitted fields and rounds logical pixels",async t=>{
  const mock=await desktop(t);
  await WindowManagement.setWindowBounds({id:"a1",bounds:{position:{x:-1400.4},size:{height:700.8}}});
  const calls=await mock.calls();
  assert.equal(calls.length,2);
  assert.match(calls[0],/fullscreen_state.*internal=0,client=0,action="set".*float.*action="enable"/);
  assert.match(calls[1],/resize\(\{window="stableid:a1",x=800,y=701,relative=false/);
  assert.match(calls[1],/move\(\{window="stableid:a1",x=-1400,y=100,relative=false/);
  assert.ok(calls.every(call=>!call.includes("dsp.focus")));
});

test("desktop-only moves preserve fullscreen and floating state and use named workspace selectors",async t=>{
  const mock=await desktop(t);
  await WindowManagement.setWindowBounds({id:"a1",desktopId:"4"});
  await WindowManagement.setWindowBounds({id:"a1",desktopId:"-99",bounds:{}});
  assert.deepEqual(await mock.calls(),[
    'hl.dispatch(hl.dsp.window.move({window="stableid:a1",workspace="name:work",follow=false}))',
    'hl.dispatch(hl.dsp.window.move({window="stableid:a1",workspace="special:scratchpad",follow=false}))',
  ]);
});

test("invalid geometry, desktop and missing targets reject before any window mutation",async t=>{
  const mock=await desktop(t);
  for(const bounds of ["maximized",[],{position:null},{size:"large"},{position:{x:Infinity}},{position:{y:-2147483649}},{size:{width:2147483648}},{size:{width:0}},{size:{height:-1}}]) {
    await assert.rejects(WindowManagement.setWindowBounds({id:"a1",desktopId:"4",bounds:bounds as WindowBounds}));
  }
  await assert.rejects(WindowManagement.setWindowBounds({id:"a1",desktopId:"missing",bounds:{size:{width:100}}}),/desktop.*available/);
  await assert.rejects(WindowManagement.setWindowBounds({id:"c3",bounds:"fullscreen"}),/window.*available/);
  assert.deepEqual(await mock.calls(),[]);
});

test("malformed compositor window data fails before issuing mutations", async t => {
  const mock = await desktop(t);
  mock.fixture.clients[0].at = [NaN, 20];
  await mock.write();
  await assert.rejects(WindowManagement.setWindowBounds({id: "a1", bounds: "fullscreen"}), /invalid window/);
  assert.deepEqual(await mock.calls(), []);
});
