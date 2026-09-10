import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const query = async command => JSON.parse((await execute("hyprctl",["-j",command])).stdout);
const evaluate = async code => { const {stdout,stderr} = await execute("hyprctl",["eval",code]); if (stdout.trim() !== "ok") throw new Error(`Hyprland: ${stdout}${stderr}`); };
const previous = () => JSON.parse(process.env.COMMAND_SPACE_FRONTMOST || "null");
const id = window => String(window.stableId || window.id);
function windowValue(window, active) {
  return {id:id(window), title:window.title, active:id(window) === id(active || {}), desktopId:String(window.workspace.id), fullScreenSettable:true, positionable:true, resizable:true,
    bounds:window.fullscreen ? "fullscreen" : {position:{x:window.at[0],y:window.at[1]},size:{width:window.size[0],height:window.size[1]}},
    application:{name:window.class,bundleId:window.class,path:"",pid:window.pid}};
}
export const WindowManagement = {
  __commandSpaceCapability:"windows",
  DesktopType:{User:"user",FullScreen:"fullScreen"},
  async getWindows() {
    const active = previous() || await query("activewindow");
    return (await query("clients")).filter(window => window.mapped && window.class !== "command-space").map(window => windowValue(window,active));
  },
  async getActiveWindow() {
    const active = (await this.getWindows()).find(window => window.active);
    if (!active) throw new Error("There is no active application window");
    return active;
  },
  async getWindowsOnActiveDesktop() {
    const desktops = new Set((await this.getDesktops()).filter(desktop => desktop.active).map(desktop => desktop.id));
    return (await this.getWindows()).filter(window => desktops.has(window.desktopId));
  },
  async getDesktops() {
    const [workspaces,monitors] = await Promise.all([query("workspaces"),query("monitors")]);
    return workspaces.map(workspace => {
      const monitor = monitors.find(m => m.id === workspace.monitorID || m.name === workspace.monitor) || monitors[0];
      const scale = Math.round(monitor.scale * 120) / 120;
      const rotated = monitor.transform % 2;
      return {id:String(workspace.id),screenId:String(monitor.id),active:[monitor.activeWorkspace?.id,monitor.specialWorkspace?.id].includes(workspace.id),type:"user",
        size:{width:(rotated ? monitor.height : monitor.width)/scale,height:(rotated ? monitor.width : monitor.height)/scale}};
    });
  },
  async setWindowBounds(options) {
    const window = (await query("clients")).find(window => id(window) === options.id && window.mapped && window.class !== "command-space");
    if (!window) throw new Error("The window is no longer available");
    const target = JSON.stringify(`stableid:${id(window)}`);
    if (options.bounds === "fullscreen") return evaluate(`hl.dispatch(hl.dsp.window.fullscreen({window=${target},action="set"}))`);
    const bounds = options.bounds || {};
    const x = bounds.position?.x ?? window.at[0], y = bounds.position?.y ?? window.at[1];
    const width = bounds.size?.width ?? window.size[0], height = bounds.size?.height ?? window.size[1];
    if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Window bounds must contain finite coordinates and positive dimensions");
    if (options.desktopId) {
      const workspace = (await query("workspaces")).find(workspace => String(workspace.id) === options.desktopId);
      if (!workspace) throw new Error("The desktop is no longer available");
      await evaluate(`hl.dispatch(hl.dsp.window.move({window=${target},workspace=${JSON.stringify(workspace.name)},follow=false}))`);
    }
    await evaluate(`hl.dispatch(hl.dsp.window.fullscreen({window=${target},action="unset"})); hl.dispatch(hl.dsp.window.float({window=${target},action="enable"})); hl.dispatch(hl.dsp.window.resize({window=${target},x=${width},y=${height},relative=false})); hl.dispatch(hl.dsp.window.move({window=${target},x=${x},y=${y},relative=false}))`);
  },
};
