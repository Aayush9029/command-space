import {execFile} from "node:child_process";
import {promisify} from "node:util";
const execute = promisify(execFile);
const query = async command => JSON.parse((await execute("hyprctl",["-j",command])).stdout);
const evaluate = async code => { const {stdout,stderr} = await execute("hyprctl",["eval",code]); if (stdout.trim() !== "ok") throw new Error(`Hyprland: ${stdout}${stderr}`); };
const previous = () => JSON.parse(process.env.SUPER_SPACE_FRONTMOST || "null");
const id = window => String(window?.stableId ?? window?.id ?? "");
const available = window => window.mapped && window.class !== "super-space";
const workspaceSelector = workspace => workspace.id < 0 || /^\d+$/.test(workspace.name) ? workspace.name : `name:${workspace.name}`;
function windowValue(window, active) {
  return {id:id(window),title:window.title,active:id(window)===id(active),desktopId:String(window.workspace.id),fullScreenSettable:true,positionable:true,resizable:true,
    bounds:(window.fullscreen & 2)!==0 ? "fullscreen" : {position:{x:window.at[0],y:window.at[1]},size:{width:window.size[0],height:window.size[1]}},
    application:{name:window.class,bundleId:window.class,path:"",pid:window.pid}};
}
export const WindowManagement = {
  __superSpaceCapability:"windows",
  DesktopType:{User:"user",FullScreen:"fullScreen"},
  async getWindows() {
    const active = previous() || await query("activewindow");
    return (await query("clients")).filter(available).map(window => windowValue(window,active));
  },
  async getActiveWindow() {
    const active = (await WindowManagement.getWindows()).find(window => window.active);
    if (!active) throw new Error("There is no active application window");
    return active;
  },
  async getWindowsOnActiveDesktop() {
    const desktops = new Set((await WindowManagement.getDesktops()).filter(desktop => desktop.active).map(desktop => desktop.id));
    return (await WindowManagement.getWindows()).filter(window => desktops.has(window.desktopId));
  },
  async getDesktops() {
    const [workspaces,monitors] = await Promise.all([query("workspaces"),query("monitors")]);
    const preferred = previous()?.monitor ?? monitors.find(monitor=>monitor.focused)?.id;
    return workspaces.flatMap(workspace => {
      const monitor = monitors.find(monitor => !monitor.disabled && (monitor.id===workspace.monitorID || monitor.name===workspace.monitor));
      if (!monitor) return [];
      const scale = Math.max(0.1,Math.round((monitor.scale || 1)*120)/120);
      const rotated = (monitor.transform || 0)%2!==0;
      return [{id:String(workspace.id),name:workspace.name,screenId:String(monitor.id),active:[monitor.activeWorkspace?.id,monitor.specialWorkspace?.id].includes(workspace.id),type:"user",
        size:{width:Math.round((rotated?monitor.height:monitor.width)/scale),height:Math.round((rotated?monitor.width:monitor.height)/scale)}}];
    }).sort((left,right)=>Number(right.screenId===String(preferred))-Number(left.screenId===String(preferred)) || Number(right.active)-Number(left.active) || Number(left.id)-Number(right.id));
  },
  async setWindowBounds(options) {
    const window = (await query("clients")).find(window => id(window)===options.id && available(window));
    if (!window) throw new Error("The window is no longer available");
    const target = JSON.stringify(`stableid:${id(window)}`);
    const bounds = options.bounds ?? {};
    if (bounds!=="fullscreen" && (typeof bounds!=="object" || Array.isArray(bounds))) throw new Error("Window bounds must be a position and size object or fullscreen");
    if (bounds!=="fullscreen" && [bounds.position,bounds.size].some(value=>value!==undefined && (value===null || typeof value!=="object" || Array.isArray(value)))) throw new Error("Window position and size must be objects");
    const values = [bounds.position?.x,bounds.position?.y,bounds.size?.width,bounds.size?.height];
    if (bounds!=="fullscreen" && (values.some(value=>value!==undefined && (!Number.isFinite(value) || value < -2147483648 || value > 2147483647)) || [bounds.size?.width,bounds.size?.height].some(value=>value!==undefined && value<=0))) throw new Error("Window bounds must contain finite 32-bit coordinates and positive dimensions");
    if (options.desktopId!==undefined) {
      const workspace = (await query("workspaces")).find(workspace => String(workspace.id)===options.desktopId);
      if (!workspace) throw new Error("The desktop is no longer available");
      await evaluate(`hl.dispatch(hl.dsp.window.move({window=${target},workspace=${JSON.stringify(workspaceSelector(workspace))},follow=false}))`);
    }
    if (bounds==="fullscreen") return evaluate(`hl.dispatch(hl.dsp.window.fullscreen({window=${target},mode="fullscreen",action="set"}))`);
    if (values.every(value=>value===undefined)) return;
    await evaluate(`hl.dispatch(hl.dsp.window.fullscreen_state({window=${target},internal=0,client=0,action="set"})); hl.dispatch(hl.dsp.window.float({window=${target},action="enable"}))`);
    const current = (await query("clients")).find(candidate=>id(candidate)===options.id && available(candidate));
    if (!current) throw new Error("The window is no longer available");
    const x=Math.round(bounds.position?.x ?? current.at[0]),y=Math.round(bounds.position?.y ?? current.at[1]);
    const width=Math.max(1,Math.round(bounds.size?.width ?? current.size[0])),height=Math.max(1,Math.round(bounds.size?.height ?? current.size[1]));
    await evaluate(`hl.dispatch(hl.dsp.window.resize({window=${target},x=${width},y=${height},relative=false})); hl.dispatch(hl.dsp.window.move({window=${target},x=${x},y=${y},relative=false}))`);
  },
};
