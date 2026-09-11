import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {WindowManagement} from "../runtime/windows.ts";

interface Client {
  stableId: string;
  class: string;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name: string };
  monitor: number;
  floating: boolean;
  fullscreen: number;
  pinned: boolean;
}

interface Monitor {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  transform: number;
  reserved: [number, number, number, number];
}

interface Geometry {
  position?: { x?: number; y?: number };
  size?: { width?: number; height?: number };
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a Hyprland object");
}

function number(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isFinite(value), "Expected a finite Hyprland number");
  return value;
}

function text(value: unknown): string {
  assert.ok(typeof value === "string", "Expected a Hyprland string");
  return value;
}

function pair(value: unknown): [number, number] {
  assert.ok(Array.isArray(value) && value.length === 2, "Expected two coordinates");
  return [number(value[0]), number(value[1])];
}

function clientValue(value: unknown): Client {
  record(value);
  record(value.workspace);
  assert.ok(typeof value.floating === "boolean" && typeof value.pinned === "boolean");
  return {
    stableId: text(value.stableId), class: text(value.class), at: pair(value.at), size: pair(value.size),
    workspace: { id: number(value.workspace.id), name: text(value.workspace.name) },
    monitor: number(value.monitor), floating: value.floating, fullscreen: number(value.fullscreen), pinned: value.pinned,
  };
}

function monitorValue(value: unknown): Monitor {
  record(value);
  assert.ok(Array.isArray(value.reserved) && value.reserved.length === 4, "Expected four reserved monitor margins");
  return {
    id: number(value.id), x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height),
    scale: number(value.scale), transform: number(value.transform),
    reserved: [number(value.reserved[0]), number(value.reserved[1]), number(value.reserved[2]), number(value.reserved[3])],
  };
}

const run=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary=process.env.SUPER_SPACE_BINARY || path.join(root,"target/debug/super-space");
const requestedId=process.env.SUPER_SPACE_WINDOW_TEST_ID;
assert.ok(requestedId,"Set SUPER_SPACE_WINDOW_TEST_ID to a disposable validation window");
const id: string = requestedId;
const query=async (name: string): Promise<unknown>=>JSON.parse((await run("hyprctl",["-j",name])).stdout);
async function clients(): Promise<Client[]> {
  const value = await query("clients");
  assert.ok(Array.isArray(value), "Expected Hyprland clients");
  return (value as unknown[]).map(clientValue);
}
async function monitors(): Promise<Monitor[]> {
  const value = await query("monitors");
  assert.ok(Array.isArray(value), "Expected Hyprland monitors");
  return (value as unknown[]).map(monitorValue);
}
const evalLua=async (code: string)=>assert.equal((await run("hyprctl",["eval",code])).stdout.trim(),"ok");
const read=async()=>{
  const client=(await clients()).find(client=>client.stableId===id);
  assert.ok(client, "The disposable validation window must exist");
  assert.equal(client?.class,"super-space-window-validation","Only an explicitly marked disposable window can be tested");
  return client;
};
function geometryEqual(actual: unknown,expected: unknown,label="geometry"): void {
  if(typeof expected==="number") {
    assert.ok(typeof actual === "number", `${label}: expected a number`);
    return assert.ok(Math.abs(actual-expected)<=1,`${label}: expected ${expected}, received ${actual}`);
  }
  assert.ok(expected !== null && typeof expected === "object", `${label}: expected a geometry object`);
  assert.ok(actual !== null && typeof actual === "object", `${label}: received no geometry object`);
  for(const [key,value] of Object.entries(expected as Record<string, unknown>)) geometryEqual((actual as Record<string, unknown>)[key],value,`${label}.${key}`);
}
const before=await read();
assert.ok(before.workspace.id>=9900,"Use an isolated validation workspace");
process.env.SUPER_SPACE_FRONTMOST=JSON.stringify(before);
const target=JSON.stringify(`stableid:${id}`);
const monitor=(await monitors()).find(monitor=>monitor.id===before.monitor);
assert.ok(monitor, "The disposable window must have a monitor");
const scale=Math.round(monitor.scale*120)/120,rotated=monitor.transform%2!==0;
const reserved=monitor.reserved;
const area={x:monitor.x+reserved[0],y:monitor.y+reserved[1],
  width:Math.round((rotated?monitor.height:monitor.width)/scale)-reserved[0]-reserved[2],
  height:Math.round((rotated?monitor.width:monitor.height)/scale)-reserved[1]-reserved[3]};
const bounds=(client: Client)=>({position:{x:client.at[0],y:client.at[1]},size:{width:client.size[0],height:client.size[1]}});
const settled=async()=>{await new Promise(resolve=>setTimeout(resolve,150));return read();};
const checks: string[]=[];
async function operate(operation: string){
  await run(binary,["window",operation,id]);
  const result=await settled();
  const active = await query("activewindow");
  record(active);
  assert.notEqual(active.stableId,id,`${operation} must not steal focus`);
  checks.push(operation);
  return result;
}
async function setGeometry(geometry: Geometry){await WindowManagement.setWindowBounds({id,bounds:geometry});return settled();}
assert.ok(area.width > 0 && area.height > 0, "The validation monitor must have a usable work area");
const baseSize={
  width:Math.min(area.width,Math.max(160,Math.min(700,area.width-100))),
  height:Math.min(area.height,Math.max(100,Math.min(500,area.height-100))),
};
const base={position:{x:Math.round(area.x+(area.width-baseSize.width)/2),y:Math.round(area.y+(area.height-baseSize.height)/2)},size:baseSize};
const largerSize={width:Math.min(base.size.width+100,area.width),height:Math.min(base.size.height+100,area.height)};
const partialX=area.x+area.width-base.size.width;
const partialHeight=Math.min(650,area.y+area.height-base.position.y);
const expectedRegion=([x,y,width,height]: readonly [number, number, number, number])=>{
  const left=Math.round(area.x+area.width*x),top=Math.round(area.y+area.height*y);
  return {position:{x:left,y:top},size:{width:Math.round(area.x+area.width*(x+width))-left,height:Math.round(area.y+area.height*(y+height))-top}};
};
const regions: Record<string, readonly [number, number, number, number]>={
  "left-half":[0,0,.5,1],"right-half":[.5,0,.5,1],"center-half":[.25,0,.5,1],"top-half":[0,0,1,.5],"bottom-half":[0,.5,1,.5],
  "top-left":[0,0,.5,.5],"top-right":[.5,0,.5,.5],"bottom-left":[0,.5,.5,.5],"bottom-right":[.5,.5,.5,.5],
  "left-third":[0,0,1/3,1],"center-third":[1/3,0,1/3,1],"right-third":[2/3,0,1/3,1],
  "left-two-thirds":[0,0,2/3,1],"right-two-thirds":[1/3,0,2/3,1],
  "top-third":[0,0,1,1/3],"middle-third":[0,1/3,1,1/3],"bottom-third":[0,2/3,1,1/3],
  "top-two-thirds":[0,0,1,2/3],"bottom-two-thirds":[0,1/3,1,2/3],
  "first-fourth":[0,0,.25,1],"second-fourth":[.25,0,.25,1],"third-fourth":[.5,0,.25,1],"last-fourth":[.75,0,.25,1],
  "top-left-sixth":[0,0,1/3,.5],"top-center-sixth":[1/3,0,1/3,.5],"top-right-sixth":[2/3,0,1/3,.5],
  "bottom-left-sixth":[0,.5,1/3,.5],"bottom-center-sixth":[1/3,.5,1/3,.5],"bottom-right-sixth":[2/3,.5,1/3,.5],"maximize":[0,0,1,1],
};
try {
  await evalLua(`hl.dispatch(hl.dsp.window.set_prop({window=${target},prop="no_anim",value="1"}))`);
  for(const [operation,region] of Object.entries(regions)) geometryEqual(bounds(await operate(operation)),expectedRegion(region),operation);
  geometryEqual(bounds(await setGeometry(base)),base,"initial API bounds");
  geometryEqual(bounds(await operate("move-left")),{...base,position:{...base.position,x:area.x}});
  geometryEqual(bounds(await operate("move-right")),{...base,position:{x:area.x+area.width-base.size.width,y:base.position.y}});
  assert.equal((await operate("move-up")).at[1],area.y);
  assert.equal((await operate("move-down")).at[1],area.y+area.height-base.size.height);
  geometryEqual(bounds(await operate("center")),base);
  await setGeometry(base);
  geometryEqual((await operate("larger")).size,[largerSize.width,largerSize.height]);
  geometryEqual((await operate("smaller")).size,[base.size.width,base.size.height]);
  geometryEqual((await operate("maximize-width")).size,[area.width,base.size.height]);
  await setGeometry(base);
  geometryEqual((await operate("maximize-height")).size,[base.size.width,area.height]);
  geometryEqual((await operate("reasonable-size")).size,[Math.min(1025,Math.round(area.width*.6)),Math.min(900,Math.round(area.height*.6))]);
  await setGeometry(base);
  await operate("left-half");
  geometryEqual(bounds(await operate("restore")),base);
  assert.equal((await operate("tile")).floating,false);
  assert.equal((await operate("float")).floating,true);
  assert.equal((await operate("toggle-floating")).floating,false);
  assert.equal((await operate("restore")).floating,true);
  assert.equal((await operate("toggle-fullscreen")).fullscreen,2);
  assert.equal((await WindowManagement.getActiveWindow()).bounds,"fullscreen");
  assert.equal((await operate("toggle-fullscreen")).fullscreen,0);
  await operate("workspace:9902");
  assert.equal((await read()).workspace.id,9902);
  assert.equal((await operate("restore")).workspace.id,9901);
  assert.equal((await operate("next-workspace")).workspace.id,9902);
  assert.equal((await operate("previous-workspace")).workspace.id,9901);
  assert.equal((await operate("scratchpad")).workspace.name,"special:scratchpad");
  assert.equal((await operate("restore")).workspace.id,9901);
  if((await monitors()).length===1){
    for(const operation of ["next-display","previous-display"]) await assert.rejects(run(binary,["window",operation,id]),/Only one display/);
    checks.push("single-display rejection");
  } else {
    await setGeometry(base);
    const moved=await operate("next-display");
    assert.notEqual(moved.monitor,before.monitor);
    const desktop=(await WindowManagement.getDesktops()).find((desktop: { id: string; size: { width: number; height: number } })=>desktop.id===String(moved.workspace.id));
    assert.ok(desktop, "The moved window must have a desktop");
    assert.ok(moved.size[0]<=desktop.size.width && moved.size[1]<=desktop.size.height);
    assert.equal((await operate("restore")).workspace.id,before.workspace.id);
    geometryEqual(bounds(await read()),base);
    assert.notEqual((await operate("previous-display")).monitor,before.monitor);
    assert.equal((await operate("restore")).monitor,before.monitor);
  }
  if(process.env.SUPER_SPACE_WINDOW_VISIBLE_TEST){
    assert.equal((await operate("toggle-pin")).pinned,true);
    assert.equal((await operate("restore")).pinned,false);
    const secondId=process.env.SUPER_SPACE_SECOND_WINDOW_TEST_ID;
    if(secondId){
      const second=(await clients()).find(client=>client.stableId===secondId);
      assert.ok(second, "The second disposable validation window must exist");
      assert.equal(second?.class,"super-space-window-validation");
      assert.equal(second.workspace.id,before.workspace.id);
      await evalLua(`hl.dispatch(hl.dsp.window.float({window=${JSON.stringify(`stableid:${secondId}`)},action="disable"}))`);
      const layouts=new Set([JSON.stringify(bounds(await operate("tile")))]);
      for(const direction of ["left","right","up","down"]) layouts.add(JSON.stringify(bounds(await operate(`move-tile-${direction}`))));
      assert.ok(layouts.size>1,"Directional tile moves must change the actual layout");
      await operate("float");
    }
  }
  await setGeometry(base);
  geometryEqual(bounds(await setGeometry({position:{x:partialX}})),{...base,position:{x:partialX,y:base.position.y}});
  geometryEqual(bounds(await setGeometry({size:{height:partialHeight}})),{position:{x:partialX,y:base.position.y},size:{width:base.size.width,height:partialHeight}});
  await WindowManagement.setWindowBounds({id,bounds:"fullscreen"});await settled();
  await evalLua(`hl.dispatch(hl.dsp.window.fullscreen({window=${target},mode="maximized",action="set"}))`);await settled();
  assert.equal(typeof (await WindowManagement.getActiveWindow()).bounds,"object");
  const beforeMove=await read();
  await WindowManagement.setWindowBounds({id,desktopId:String(before.workspace.id)});await settled();
  assert.equal((await read()).fullscreen,beforeMove.fullscreen);
  await evalLua(`hl.dispatch(hl.dsp.window.move({window=${target},workspace=9901,follow=false}))`);await settled();
  await setGeometry(base);
  checks.push("API partial geometry","API fullscreen/maximized","API desktop-only state preservation");
  console.log(JSON.stringify({ok:true,window:id,workArea:area,base,geometryPresets:Object.keys(regions).length,checks:checks.length,operations:[...new Set(checks)],focusPreserved:true},null,2));
} finally {
  await evalLua(`hl.dispatch(hl.dsp.window.fullscreen_state({window=${target},internal=0,client=0,action="set"}));hl.dispatch(hl.dsp.window.float({window=${target},action="enable"}));hl.dispatch(hl.dsp.window.move({window=${target},workspace=${before.workspace.id},follow=false}))`);
  await WindowManagement.setWindowBounds({id,bounds:bounds(before)});
}
