import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {WindowManagement} from "../runtime/windows.mjs";

const run=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary=process.env.COMMAND_SPACE_BINARY || path.join(root,"target/debug/command-space");
const id=process.env.COMMAND_SPACE_WINDOW_TEST_ID;
assert.ok(id,"Set COMMAND_SPACE_WINDOW_TEST_ID to a disposable validation window");
const query=async name=>JSON.parse((await run("hyprctl",["-j",name])).stdout);
const evalLua=async code=>assert.equal((await run("hyprctl",["eval",code])).stdout.trim(),"ok");
const read=async()=>{
  const client=(await query("clients")).find(client=>client.stableId===id);
  assert.equal(client?.class,"command-space-window-validation","Only an explicitly marked disposable window can be tested");
  return client;
};
function geometryEqual(actual,expected,label="geometry") {
  if(typeof expected==="number") return assert.ok(Math.abs(actual-expected)<=1,`${label}: expected ${expected}, received ${actual}`);
  for(const [key,value] of Object.entries(expected)) geometryEqual(actual[key],value,`${label}.${key}`);
}
const before=await read();
assert.ok(before.workspace.id>=9900,"Use an isolated validation workspace");
process.env.COMMAND_SPACE_FRONTMOST=JSON.stringify(before);
const target=JSON.stringify(`stableid:${id}`);
const monitor=(await query("monitors")).find(monitor=>monitor.id===before.monitor);
const scale=Math.round(monitor.scale*120)/120,rotated=monitor.transform%2!==0;
const reserved=monitor.reserved;
const area={x:monitor.x+reserved[0],y:monitor.y+reserved[1],
  width:Math.round((rotated?monitor.height:monitor.width)/scale)-reserved[0]-reserved[2],
  height:Math.round((rotated?monitor.width:monitor.height)/scale)-reserved[1]-reserved[3]};
const bounds=client=>({position:{x:client.at[0],y:client.at[1]},size:{width:client.size[0],height:client.size[1]}});
const settled=async()=>{await new Promise(resolve=>setTimeout(resolve,150));return read();};
const checks=[];
async function operate(operation){
  await run(binary,["window",operation,id]);
  const result=await settled();
  assert.notEqual((await query("activewindow")).stableId,id,`${operation} must not steal focus`);
  checks.push(operation);
  return result;
}
async function setGeometry(geometry){await WindowManagement.setWindowBounds({id,bounds:geometry});return settled();}
const base={position:{x:area.x+120,y:area.y+100},size:{width:700,height:500}};
const expectedRegion=([x,y,width,height])=>{
  const left=Math.round(area.x+area.width*x),top=Math.round(area.y+area.height*y);
  return {position:{x:left,y:top},size:{width:Math.round(area.x+area.width*(x+width))-left,height:Math.round(area.y+area.height*(y+height))-top}};
};
const regions={
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
  await setGeometry(base);
  geometryEqual(bounds(await operate("move-left")),{...base,position:{...base.position,x:area.x}});
  geometryEqual(bounds(await operate("move-right")),{...base,position:{x:area.x+area.width-700,y:base.position.y}});
  assert.equal((await operate("move-up")).at[1],area.y);
  assert.equal((await operate("move-down")).at[1],area.y+area.height-500);
  geometryEqual(bounds(await operate("center")),{...base,position:{x:Math.round(area.x+(area.width-700)/2),y:Math.round(area.y+(area.height-500)/2)}});
  await setGeometry(base);
  geometryEqual((await operate("larger")).size,[800,600]);
  geometryEqual((await operate("smaller")).size,[700,500]);
  geometryEqual((await operate("maximize-width")).size,[area.width,500]);
  await setGeometry(base);
  geometryEqual((await operate("maximize-height")).size,[700,area.height]);
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
  if((await query("monitors")).length===1){
    for(const operation of ["next-display","previous-display"]) await assert.rejects(run(binary,["window",operation,id]),/Only one display/);
    checks.push("single-display rejection");
  } else {
    await setGeometry(base);
    const moved=await operate("next-display");
    assert.notEqual(moved.monitor,before.monitor);
    const desktop=(await WindowManagement.getDesktops()).find(desktop=>desktop.id===String(moved.workspace.id));
    assert.ok(moved.size[0]<=desktop.size.width && moved.size[1]<=desktop.size.height);
    assert.equal((await operate("restore")).workspace.id,before.workspace.id);
    geometryEqual(bounds(await read()),base);
    assert.notEqual((await operate("previous-display")).monitor,before.monitor);
    assert.equal((await operate("restore")).monitor,before.monitor);
  }
  if(process.env.COMMAND_SPACE_WINDOW_VISIBLE_TEST){
    assert.equal((await operate("toggle-pin")).pinned,true);
    assert.equal((await operate("restore")).pinned,false);
    const secondId=process.env.COMMAND_SPACE_SECOND_WINDOW_TEST_ID;
    if(secondId){
      const second=(await query("clients")).find(client=>client.stableId===secondId);
      assert.equal(second?.class,"command-space-window-validation");
      assert.equal(second.workspace.id,before.workspace.id);
      await evalLua(`hl.dispatch(hl.dsp.window.float({window=${JSON.stringify(`stableid:${secondId}`)},action="disable"}))`);
      const layouts=new Set([JSON.stringify(bounds(await operate("tile")))]);
      for(const direction of ["left","right","up","down"]) layouts.add(JSON.stringify(bounds(await operate(`move-tile-${direction}`))));
      assert.ok(layouts.size>1,"Directional tile moves must change the actual layout");
      await operate("float");
    }
  }
  await setGeometry(base);
  geometryEqual(bounds(await setGeometry({position:{x:area.x+300}})),{...base,position:{x:area.x+300,y:base.position.y}});
  geometryEqual(bounds(await setGeometry({size:{height:650}})),{position:{x:area.x+300,y:base.position.y},size:{width:700,height:650}});
  await WindowManagement.setWindowBounds({id,bounds:"fullscreen"});await settled();
  await evalLua(`hl.dispatch(hl.dsp.window.fullscreen({window=${target},mode="maximized",action="set"}))`);await settled();
  assert.equal(typeof (await WindowManagement.getActiveWindow()).bounds,"object");
  const beforeMove=await read();
  await WindowManagement.setWindowBounds({id,desktopId:String(before.workspace.id)});await settled();
  assert.equal((await read()).fullscreen,beforeMove.fullscreen);
  await evalLua(`hl.dispatch(hl.dsp.window.move({window=${target},workspace=9901,follow=false}))`);await settled();
  await setGeometry(base);
  checks.push("API partial geometry","API fullscreen/maximized","API desktop-only state preservation");
  console.log(JSON.stringify({ok:true,window:id,geometryPresets:Object.keys(regions).length,checks:checks.length,operations:[...new Set(checks)],focusPreserved:true},null,2));
} finally {
  await evalLua(`hl.dispatch(hl.dsp.window.fullscreen_state({window=${target},internal=0,client=0,action="set"}));hl.dispatch(hl.dsp.window.float({window=${target},action="enable"}));hl.dispatch(hl.dsp.window.move({window=${target},workspace=${before.workspace.id},follow=false}))`);
  await WindowManagement.setWindowBounds({id,bounds:bounds(before)});
}
