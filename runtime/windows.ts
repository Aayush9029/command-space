import {isRecord, runDesktopCommand} from "./adapter-utils.ts";
import type {Application} from "./applications.ts";

interface Workspace { id: number; name: string; monitorID?: number; monitor?: string }
interface Monitor {
  id: number; name: string; width: number; height: number; scale?: number; transform?: number; focused?: boolean;
  activeWorkspace?: {id: number}; specialWorkspace?: {id: number};
}
interface Client {
  stableId?: string | number; id?: string | number; title: string; class: string; pid?: number;
  workspace: Workspace; fullscreen: number; at: [number, number]; size: [number, number];
}
export interface WindowGeometry { position?: {x?: number; y?: number}; size?: {width?: number; height?: number} }
export type WindowBounds = "fullscreen" | WindowGeometry;
export interface WindowBoundsOptions { id: string; desktopId?: string; bounds?: WindowBounds }
export interface WindowInfo {
  id: string; title: string; active: boolean; desktopId: string; fullScreenSettable: boolean; positionable: boolean; resizable: boolean;
  bounds: WindowBounds; application: Application;
}
export interface DesktopInfo {id: string; name: string; screenId: string; active: boolean; type: "user"; size: {width: number; height: number}}

async function query(command: string): Promise<unknown> { return JSON.parse(await runDesktopCommand("hyprctl", ["-j", command])); }
async function evaluate(code: string): Promise<void> {
  const stdout = await runDesktopCommand("hyprctl", ["eval", code]);
  if (stdout.trim() !== "ok") throw new Error(`Hyprland: ${stdout}`);
}
function previous(): Record<string, unknown> | undefined {
  const value: unknown = JSON.parse(process.env.SUPER_SPACE_FRONTMOST || "null");
  return isRecord(value) ? value : undefined;
}
function id(window: unknown): string {
  if (!isRecord(window)) return "";
  const value = window.stableId ?? window.id;
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1]);
function isWorkspace(value: unknown): value is Workspace {
  return isRecord(value) && finite(value.id) && typeof value.name === "string" && (value.monitorID === undefined || finite(value.monitorID)) && (value.monitor === undefined || typeof value.monitor === "string");
}
async function clients(): Promise<Client[]> {
  const value = await query("clients");
  if (!Array.isArray(value)) throw new Error("Hyprland returned an invalid window list");
  return value.flatMap((window: unknown): Client[] => {
    if (!isRecord(window) || !window.mapped || window.class === "super-space") return [];
    if (!id(window) || typeof window.title !== "string" || typeof window.class !== "string" || !isWorkspace(window.workspace) || !finite(window.fullscreen) || !pair(window.at) || !pair(window.size) || (window.pid !== undefined && !finite(window.pid))) throw new Error("Hyprland returned an invalid window");
    return [{id: id(window), title: window.title, class: window.class, workspace: window.workspace, fullscreen: window.fullscreen, at: window.at, size: window.size, ...(typeof window.pid === "number" ? {pid: window.pid} : {})}];
  });
}
async function workspaces(): Promise<Workspace[]> {
  const value = await query("workspaces");
  if (!Array.isArray(value) || !value.every(isWorkspace)) throw new Error("Hyprland returned invalid workspaces");
  return value;
}
async function monitors(): Promise<Monitor[]> {
  const value = await query("monitors");
  if (!Array.isArray(value)) throw new Error("Hyprland returned an invalid monitor list");
  return value.flatMap((monitor: unknown): Monitor[] => {
    if (isRecord(monitor) && monitor.disabled) return [];
    if (!isRecord(monitor) || !finite(monitor.id) || typeof monitor.name !== "string" || !finite(monitor.width) || !finite(monitor.height)) throw new Error("Hyprland returned an invalid monitor");
    return [{id: monitor.id, name: monitor.name, width: monitor.width, height: monitor.height,
      ...(finite(monitor.scale) ? {scale: monitor.scale} : {}), ...(finite(monitor.transform) ? {transform: monitor.transform} : {}), focused: monitor.focused === true,
      ...(isRecord(monitor.activeWorkspace) && finite(monitor.activeWorkspace.id) ? {activeWorkspace: {id: monitor.activeWorkspace.id}} : {}),
      ...(isRecord(monitor.specialWorkspace) && finite(monitor.specialWorkspace.id) ? {specialWorkspace: {id: monitor.specialWorkspace.id}} : {})}];
  });
}
const workspaceSelector = (workspace: Workspace) => workspace.id < 0 || /^\d+$/.test(workspace.name) ? workspace.name : `name:${workspace.name}`;
function windowValue(window: Client, active: unknown): WindowInfo {
  return {id: id(window), title: window.title, active: id(window) === id(active), desktopId: String(window.workspace.id), fullScreenSettable: true, positionable: true, resizable: true,
    bounds: (window.fullscreen & 2) !== 0 ? "fullscreen" : {position: {x: window.at[0], y: window.at[1]}, size: {width: window.size[0], height: window.size[1]}},
    application: {name: window.class, bundleId: window.class, path: "", ...(window.pid !== undefined ? {pid: window.pid} : {})}};
}
function checkedBounds(bounds: unknown): WindowBounds {
  if (bounds === "fullscreen") return bounds;
  if (!isRecord(bounds)) throw new Error("Window bounds must be a position and size object or fullscreen");
  for (const component of [bounds.position, bounds.size]) {
    if (component !== undefined && !isRecord(component)) throw new Error("Window position and size must be objects");
  }
  const position = isRecord(bounds.position) ? bounds.position : {}, size = isRecord(bounds.size) ? bounds.size : {};
  const values = [position.x, position.y, size.width, size.height];
  if (values.some(value => value !== undefined && (!finite(value) || value < -2147483648 || value > 2147483647)) || [size.width, size.height].some(value => finite(value) && value <= 0)) throw new Error("Window bounds must contain finite 32-bit coordinates and positive dimensions");
  return {position: {...(finite(position.x) ? {x: position.x} : {}), ...(finite(position.y) ? {y: position.y} : {})}, size: {...(finite(size.width) ? {width: size.width} : {}), ...(finite(size.height) ? {height: size.height} : {})}};
}
export const WindowManagement = {
  __superSpaceCapability: "windows",
  DesktopType: {User: "user", FullScreen: "fullScreen"},
  async getWindows(): Promise<WindowInfo[]> {
    const [active, windows] = await Promise.all([previous() || query("activewindow"), clients()]);
    return windows.map(window => windowValue(window, active));
  },
  async getActiveWindow(): Promise<WindowInfo> {
    const active = (await WindowManagement.getWindows()).find(window => window.active);
    if (!active) throw new Error("There is no active application window");
    return active;
  },
  async getWindowsOnActiveDesktop(): Promise<WindowInfo[]> {
    const [desktops, windows] = await Promise.all([WindowManagement.getDesktops(), WindowManagement.getWindows()]);
    const active = new Set(desktops.filter(desktop => desktop.active).map(desktop => desktop.id));
    return windows.filter(window => active.has(window.desktopId));
  },
  async getDesktops(): Promise<DesktopInfo[]> {
    const [spaces, displays] = await Promise.all([workspaces(), monitors()]);
    const preferred = previous()?.monitor ?? displays.find(monitor => monitor.focused)?.id;
    return spaces.flatMap((workspace): DesktopInfo[] => {
      const monitor = displays.find(monitor => monitor.id === workspace.monitorID || monitor.name === workspace.monitor);
      if (!monitor) return [];
      const scale = Math.max(0.1, Math.round((monitor.scale || 1) * 120) / 120);
      const rotated = (monitor.transform || 0) % 2 !== 0;
      return [{id: String(workspace.id), name: workspace.name, screenId: String(monitor.id), active: [monitor.activeWorkspace?.id, monitor.specialWorkspace?.id].includes(workspace.id), type: "user",
        size: {width: Math.round((rotated ? monitor.height : monitor.width) / scale), height: Math.round((rotated ? monitor.width : monitor.height) / scale)}}];
    }).sort((left, right) => Number(right.screenId === String(preferred)) - Number(left.screenId === String(preferred)) || Number(right.active) - Number(left.active) || Number(left.id) - Number(right.id));
  },
  async setWindowBounds(options: WindowBoundsOptions): Promise<void> {
    const window = (await clients()).find(window => id(window) === options.id);
    if (!window) throw new Error("The window is no longer available");
    const target = JSON.stringify(`stableid:${id(window)}`), bounds = checkedBounds(options.bounds ?? {});
    if (options.desktopId !== undefined) {
      const workspace = (await workspaces()).find(workspace => String(workspace.id) === options.desktopId);
      if (!workspace) throw new Error("The desktop is no longer available");
      await evaluate(`hl.dispatch(hl.dsp.window.move({window=${target},workspace=${JSON.stringify(workspaceSelector(workspace))},follow=false}))`);
    }
    if (bounds === "fullscreen") return evaluate(`hl.dispatch(hl.dsp.window.fullscreen({window=${target},mode="fullscreen",action="set"}))`);
    if ([bounds.position?.x, bounds.position?.y, bounds.size?.width, bounds.size?.height].every(value => value === undefined)) return;
    await evaluate(`hl.dispatch(hl.dsp.window.fullscreen_state({window=${target},internal=0,client=0,action="set"})); hl.dispatch(hl.dsp.window.float({window=${target},action="enable"}))`);
    const current = (await clients()).find(candidate => id(candidate) === options.id);
    if (!current) throw new Error("The window is no longer available");
    const x = Math.round(bounds.position?.x ?? current.at[0]), y = Math.round(bounds.position?.y ?? current.at[1]);
    const width = Math.max(1, Math.round(bounds.size?.width ?? current.size[0])), height = Math.max(1, Math.round(bounds.size?.height ?? current.size[1]));
    await evaluate(`hl.dispatch(hl.dsp.window.resize({window=${target},x=${width},y=${height},relative=false})); hl.dispatch(hl.dsp.window.move({window=${target},x=${x},y=${y},relative=false}))`);
  },
};
