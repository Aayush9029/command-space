use super::model::{Action, Config, Entry, state_dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, process::Command};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Client {
    #[serde(rename = "stableId", default)]
    pub id: String,
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub monitor: i64,
    #[serde(default)]
    pub mapped: bool,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub at: [i32; 2],
    #[serde(default)]
    pub size: [i32; 2],
    #[serde(default)]
    pub workspace: Workspace,
    #[serde(default)]
    pub floating: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub fullscreen: u8,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
}

impl Client {
    fn rect(&self) -> Rect {
        Rect {
            x: self.at[0] as f32,
            y: self.at[1] as f32,
            width: self.size[0] as f32,
            height: self.size[1] as f32,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Context {
    pub previous: Option<Client>,
    pub monitor: Value,
}

pub fn query(command: &str) -> Result<Value, String> {
    let output = Command::new("hyprctl")
        .args(["-j", command])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

pub fn eval(code: &str) -> Result<(), String> {
    let output = Command::new("hyprctl")
        .args(["eval", code])
        .output()
        .map_err(|e| e.to_string())?;
    let reply = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && reply.trim() == "ok" {
        Ok(())
    } else {
        Err(format!(
            "Hyprland: {reply}{}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

pub fn clients() -> Vec<Client> {
    query("clients")
        .ok()
        .and_then(|v| serde_json::from_value::<Vec<Client>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.mapped && c.class != "command-space")
        .collect()
}

impl Context {
    pub fn capture(follow_mouse: bool) -> Self {
        let previous = query("activewindow")
            .ok()
            .and_then(|v| serde_json::from_value::<Client>(v).ok())
            .filter(|c| c.mapped && c.class != "command-space");
        let monitors = query("monitors").unwrap_or_default();
        let cursor = if follow_mouse {
            query("cursorpos").unwrap_or_default()
        } else {
            Value::Null
        };
        let monitor = monitors
            .as_array()
            .and_then(|monitors| {
                monitors
                    .iter()
                    .find(|m| {
                        if let (Some(x), Some(y)) = (cursor["x"].as_f64(), cursor["y"].as_f64()) {
                            let rect = monitor_rect(m, false);
                            x >= f64::from(rect.x)
                                && y >= f64::from(rect.y)
                                && x < f64::from(rect.x + rect.width)
                                && y < f64::from(rect.y + rect.height)
                        } else {
                            m["focused"] == true
                        }
                    })
                    .or_else(|| monitors.first())
            })
            .cloned()
            .unwrap_or_default();
        Self { previous, monitor }
    }

    pub fn launcher_rect(&self, config: &Config) -> Rect {
        let screen = if self.monitor.is_null() {
            Rect {
                width: 1000.0,
                height: 720.0,
                ..Rect::default()
            }
        } else {
            monitor_rect(&self.monitor, true)
        };
        let width = config.width.min((screen.width - 24.0).max(240.0));
        let height = config.height.min((screen.height - 24.0).max(180.0));
        let (horizontal, vertical) = match config.position.as_str() {
            "top-left" => (0.0, 0.0),
            "top" => (0.5, 0.0),
            "top-right" => (1.0, 0.0),
            "left" => (0.0, 0.5),
            "right" => (1.0, 0.5),
            "bottom-left" => (0.0, 1.0),
            "bottom" => (0.5, 1.0),
            "bottom-right" => (1.0, 1.0),
            _ => (0.5, 0.5),
        };
        Rect {
            x: screen.x + 12.0 + (screen.width - width - 24.0).max(0.0) * horizontal,
            y: screen.y + 12.0 + (screen.height - height - 24.0).max(0.0) * vertical,
            width,
            height,
        }
    }
}

pub fn monitor_rect(monitor: &Value, reserved: bool) -> Rect {
    let number = |key: &str| monitor[key].as_f64().unwrap_or(0.0) as f32;
    let scale = ((number("scale") * 120.0).round() / 120.0).max(0.1);
    let mut width = number("width") / scale;
    let mut height = number("height") / scale;
    if monitor["transform"].as_i64().unwrap_or(0) % 2 != 0 {
        std::mem::swap(&mut width, &mut height);
    }
    let mut rect = Rect {
        x: number("x"),
        y: number("y"),
        width,
        height,
    };
    if reserved {
        let inset = |index| monitor["reserved"][index].as_f64().unwrap_or(0.0) as f32;
        rect.x += inset(0);
        rect.y += inset(1);
        rect.width -= inset(0) + inset(2);
        rect.height -= inset(1) + inset(3);
    }
    rect
}

pub const POSITIONS: &[(&str, &str)] = &[
    ("left-half", "Left Half"),
    ("right-half", "Right Half"),
    ("center-half", "Center Half"),
    ("top-half", "Top Half"),
    ("bottom-half", "Bottom Half"),
    ("top-left", "Top Left Quarter"),
    ("top-right", "Top Right Quarter"),
    ("bottom-left", "Bottom Left Quarter"),
    ("bottom-right", "Bottom Right Quarter"),
    ("left-third", "Left Third"),
    ("center-third", "Center Third"),
    ("right-third", "Right Third"),
    ("left-two-thirds", "Left Two Thirds"),
    ("right-two-thirds", "Right Two Thirds"),
    ("top-third", "Top Third"),
    ("middle-third", "Middle Third"),
    ("bottom-third", "Bottom Third"),
    ("top-two-thirds", "Top Two Thirds"),
    ("bottom-two-thirds", "Bottom Two Thirds"),
    ("first-fourth", "First Fourth"),
    ("second-fourth", "Second Fourth"),
    ("third-fourth", "Third Fourth"),
    ("last-fourth", "Last Fourth"),
    ("top-left-sixth", "Top Left Sixth"),
    ("top-center-sixth", "Top Center Sixth"),
    ("top-right-sixth", "Top Right Sixth"),
    ("bottom-left-sixth", "Bottom Left Sixth"),
    ("bottom-center-sixth", "Bottom Center Sixth"),
    ("bottom-right-sixth", "Bottom Right Sixth"),
    ("maximize", "Maximize"),
];

pub fn tile_rect(area: Rect, operation: &str) -> Result<Rect, String> {
    let (x, y, width, height) = match operation {
        "left-half" => (0.0, 0.0, 0.5, 1.0),
        "right-half" => (0.5, 0.0, 0.5, 1.0),
        "center-half" => (0.25, 0.0, 0.5, 1.0),
        "top-half" => (0.0, 0.0, 1.0, 0.5),
        "bottom-half" => (0.0, 0.5, 1.0, 0.5),
        "top-left" => (0.0, 0.0, 0.5, 0.5),
        "top-right" => (0.5, 0.0, 0.5, 0.5),
        "bottom-left" => (0.0, 0.5, 0.5, 0.5),
        "bottom-right" => (0.5, 0.5, 0.5, 0.5),
        "left-third" => (0.0, 0.0, 1.0 / 3.0, 1.0),
        "center-third" => (1.0 / 3.0, 0.0, 1.0 / 3.0, 1.0),
        "right-third" => (2.0 / 3.0, 0.0, 1.0 / 3.0, 1.0),
        "left-two-thirds" => (0.0, 0.0, 2.0 / 3.0, 1.0),
        "right-two-thirds" => (1.0 / 3.0, 0.0, 2.0 / 3.0, 1.0),
        "top-third" => (0.0, 0.0, 1.0, 1.0 / 3.0),
        "middle-third" => (0.0, 1.0 / 3.0, 1.0, 1.0 / 3.0),
        "bottom-third" => (0.0, 2.0 / 3.0, 1.0, 1.0 / 3.0),
        "top-two-thirds" => (0.0, 0.0, 1.0, 2.0 / 3.0),
        "bottom-two-thirds" => (0.0, 1.0 / 3.0, 1.0, 2.0 / 3.0),
        "first-fourth" => (0.0, 0.0, 0.25, 1.0),
        "second-fourth" => (0.25, 0.0, 0.25, 1.0),
        "third-fourth" => (0.5, 0.0, 0.25, 1.0),
        "last-fourth" => (0.75, 0.0, 0.25, 1.0),
        "top-left-sixth" => (0.0, 0.0, 1.0 / 3.0, 0.5),
        "top-center-sixth" => (1.0 / 3.0, 0.0, 1.0 / 3.0, 0.5),
        "top-right-sixth" => (2.0 / 3.0, 0.0, 1.0 / 3.0, 0.5),
        "bottom-left-sixth" => (0.0, 0.5, 1.0 / 3.0, 0.5),
        "bottom-center-sixth" => (1.0 / 3.0, 0.5, 1.0 / 3.0, 0.5),
        "bottom-right-sixth" => (2.0 / 3.0, 0.5, 1.0 / 3.0, 0.5),
        "maximize" => (0.0, 0.0, 1.0, 1.0),
        _ => return Err(format!("Unknown window position: {operation}")),
    };
    let left = (area.x + area.width * x).round();
    let top = (area.y + area.height * y).round();
    Ok(Rect {
        x: left,
        y: top,
        width: (area.x + area.width * (x + width)).round() - left,
        height: (area.y + area.height * (y + height)).round() - top,
    })
}

fn selector(id: &str) -> Result<String, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Window is no longer available".into());
    }
    Ok(format!("stableid:{id}"))
}

pub fn place(selector: &str, rect: Rect) -> Result<(), String> {
    if ![rect.x, rect.y, rect.width, rect.height]
        .into_iter()
        .all(f32::is_finite)
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("Window coordinates must be finite and dimensions must be positive".into());
    }
    let target = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    eval(&format!(
        "hl.dispatch(hl.dsp.window.resize({{window={target},x={},y={},relative=false}})); hl.dispatch(hl.dsp.window.move({{window={target},x={},y={},relative=false}}))",
        rect.width.round() as i32,
        rect.height.round() as i32,
        rect.x.round() as i32,
        rect.y.round() as i32
    ))
}

fn launcher_target(windows: &Value, pid: u32) -> Result<String, String> {
    let launcher = windows
        .as_array()
        .and_then(|windows| {
            windows.iter().rev().find(|window| {
                window["mapped"] == true
                    && window["class"] == "command-space"
                    && window["pid"] == pid
            })
        })
        .and_then(|window| window["stableId"].as_str())
        .ok_or("Launcher window is unavailable")?;
    selector(launcher)
}

pub fn raise_launcher() -> Result<(), String> {
    let target = launcher_target(&query("clients")?, std::process::id())?;
    eval(&format!(
        "hl.dispatch(hl.dsp.window.alter_zorder({{window={target:?},mode='top'}}))"
    ))
}

fn workspace_selector(workspace: &Workspace) -> String {
    if workspace.id < 0 || workspace.name.parse::<i64>().is_ok() {
        workspace.name.clone()
    } else {
        format!("name:{}", workspace.name)
    }
}

fn saved_positions() -> Value {
    let value: Value = fs::read(state_dir().join("window-positions.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    if value["instance"].as_str() == std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok().as_deref() {
        value
    } else {
        Value::Null
    }
}

fn remember(client: &Client) -> Result<(), String> {
    let mut values = saved_positions();
    if !values.is_object() {
        values = serde_json::json!({"instance":std::env::var("HYPRLAND_INSTANCE_SIGNATURE").unwrap_or_default(),"windows":{}});
    }
    values["windows"][&client.id] =
        serde_json::to_value(client).map_err(|error| error.to_string())?;
    if let Some(windows) = values["windows"].as_object_mut() {
        let live = clients()
            .into_iter()
            .map(|client| client.id)
            .collect::<std::collections::HashSet<_>>();
        windows.retain(|id, _| live.contains(id));
    }
    fs::create_dir_all(state_dir()).map_err(|error| error.to_string())?;
    let target = state_dir().join("window-positions.json");
    let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(&values).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, target).map_err(|error| error.to_string())
}

fn float_window(target: &str) -> Result<(), String> {
    eval(&format!(
        "hl.dispatch(hl.dsp.window.fullscreen_state({{window={target:?},internal=0,client=0,action='set'}})); hl.dispatch(hl.dsp.window.float({{window={target:?},action='enable'}}))"
    ))
}

fn restore(client: &Client, target: &str) -> Result<(), String> {
    let saved: Client = serde_json::from_value(saved_positions()["windows"][&client.id].clone())
        .map_err(|_| "No previous window position is saved")?;
    if saved.pid != client.pid {
        return Err("No previous position belongs to this window".into());
    }
    remember(client)?;
    let workspace = serde_json::to_string(&workspace_selector(&saved.workspace))
        .map_err(|error| error.to_string())?;
    float_window(target)?;
    eval(&format!(
        "hl.dispatch(hl.dsp.window.pin({{window={target:?},action='disable'}})); hl.dispatch(hl.dsp.window.move({{window={target:?},workspace={workspace},follow=false}}))"
    ))?;
    place(target, saved.rect())?;
    if !saved.floating {
        eval(&format!(
            "hl.dispatch(hl.dsp.window.float({{window={target:?},action='disable'}}))"
        ))?;
    }
    if saved.pinned {
        eval(&format!(
            "hl.dispatch(hl.dsp.window.pin({{window={target:?},action='enable'}}))"
        ))?;
    }
    if saved.fullscreen != 0 {
        let mode = if saved.fullscreen & 2 != 0 {
            "fullscreen"
        } else {
            "maximized"
        };
        eval(&format!(
            "hl.dispatch(hl.dsp.window.fullscreen({{window={target:?},mode={mode:?},action='set'}}))"
        ))?;
    }
    Ok(())
}

fn relative_rect(area: Rect, current: Rect, operation: &str) -> Result<Rect, String> {
    let mut rect = current;
    match operation {
        "center" => {
            rect.x = area.x + (area.width - rect.width) / 2.0;
            rect.y = area.y + (area.height - rect.height) / 2.0;
        }
        "maximize-width" => {
            rect.x = area.x;
            rect.width = area.width;
        }
        "maximize-height" => {
            rect.y = area.y;
            rect.height = area.height;
        }
        "reasonable-size" => {
            rect.width = (area.width * 0.6).min(1025.0);
            rect.height = (area.height * 0.6).min(900.0);
            rect.x = area.x + (area.width - rect.width) / 2.0;
            rect.y = area.y + (area.height - rect.height) / 2.0;
        }
        "larger" | "smaller" => {
            let delta = if operation == "larger" { 100.0 } else { -100.0 };
            let width = (rect.width + delta).clamp(160.0_f32.min(area.width), area.width);
            let height = (rect.height + delta).clamp(100.0_f32.min(area.height), area.height);
            rect.x -= (width - rect.width) / 2.0;
            rect.y -= (height - rect.height) / 2.0;
            rect.width = width;
            rect.height = height;
        }
        "move-left" => rect.x = area.x,
        "move-right" => rect.x = area.x + area.width - rect.width,
        "move-up" => rect.y = area.y,
        "move-down" => rect.y = area.y + area.height - rect.height,
        _ => return Err(format!("Unknown window operation: {operation}")),
    }
    rect.x = rect
        .x
        .clamp(area.x, (area.x + area.width - rect.width).max(area.x));
    rect.y = rect
        .y
        .clamp(area.y, (area.y + area.height - rect.height).max(area.y));
    Ok(rect)
}

fn display_rect(current: Rect, source: Rect, destination: Rect) -> Rect {
    Rect {
        x: destination.x + (current.x - source.x) / source.width * destination.width,
        y: destination.y + (current.y - source.y) / source.height * destination.height,
        width: current.width / source.width * destination.width,
        height: current.height / source.height * destination.height,
    }
}

pub fn operate(operation: &str, id: &str) -> Result<(), String> {
    let target = selector(id)?;
    let client = clients()
        .into_iter()
        .find(|client| client.id == id)
        .ok_or("The selected window has closed")?;
    match operation {
        "close" => {
            return eval(&format!(
                "hl.dispatch(hl.dsp.window.close({{window={target:?}}}))"
            ));
        }
        "focus" => return eval(&format!("hl.dispatch(hl.dsp.focus({{window={target:?}}}))")),
        "restore" => return restore(&client, &target),
        _ => {}
    }
    let monitors = query("monitors")?;
    let monitors = monitors.as_array().ok_or("Display list unavailable")?;
    let monitor = monitors
        .iter()
        .find(|monitor| monitor["id"] == client.monitor)
        .ok_or("Window monitor unavailable")?;
    let area = monitor_rect(monitor, true);
    if let Some(number) = operation.strip_prefix("workspace:") {
        let workspace = number
            .parse::<i64>()
            .ok()
            .filter(|value| (1..=i32::MAX as i64).contains(value))
            .ok_or("Workspace must be a positive number")?;
        remember(&client)?;
        return eval(&format!(
            "hl.dispatch(hl.dsp.window.move({{window={target:?},workspace={workspace:?},follow=false}}))"
        ));
    }
    if matches!(
        operation,
        "next-workspace" | "previous-workspace" | "scratchpad"
    ) {
        let workspace = if operation == "scratchpad" {
            "special:scratchpad".into()
        } else {
            let delta = if operation == "next-workspace" { 1 } else { -1 };
            let workspace = client.workspace.id.max(1);
            if workspace <= 10 {
                ((workspace - 1 + delta).rem_euclid(10) + 1).to_string()
            } else {
                (workspace + delta).clamp(1, i32::MAX as i64).to_string()
            }
        };
        remember(&client)?;
        return eval(&format!(
            "hl.dispatch(hl.dsp.window.move({{window={target:?},workspace={workspace:?},follow=false}}))"
        ));
    }
    if matches!(operation, "next-display" | "previous-display") {
        let mut displays = monitors
            .iter()
            .filter(|monitor| {
                monitor["disabled"] != true
                    && monitor["mirrorOf"]
                        .as_str()
                        .is_none_or(|value| value == "none")
            })
            .collect::<Vec<_>>();
        displays.sort_by_key(|monitor| monitor["id"].as_i64().unwrap_or_default());
        if displays.len() < 2 {
            return Err("Only one display is available".into());
        }
        let index = displays
            .iter()
            .position(|monitor| monitor["id"] == client.monitor)
            .ok_or("Window display is unavailable")?;
        let destination = displays[(index
            + if operation == "next-display" {
                1
            } else {
                displays.len() - 1
            })
            % displays.len()];
        let name = destination["name"]
            .as_str()
            .ok_or("Display name is unavailable")?;
        remember(&client)?;
        eval(&format!(
            "hl.dispatch(hl.dsp.window.move({{window={target:?},monitor={name:?},follow=false}}))"
        ))?;
        if client.floating && client.fullscreen == 0 {
            place(
                &target,
                display_rect(client.rect(), area, monitor_rect(destination, true)),
            )?;
        }
        return Ok(());
    }
    let dispatch = match operation {
        "toggle-fullscreen" => Some("fullscreen({ACTION,mode='fullscreen',action='toggle'})"),
        "float" => Some("float({ACTION,action='enable'})"),
        "tile" => Some("float({ACTION,action='disable'})"),
        "toggle-floating" => Some("float({ACTION,action='toggle'})"),
        "toggle-pin" => Some("pin({ACTION,action='toggle'})"),
        "move-tile-left" => Some("move({ACTION,direction='l'})"),
        "move-tile-right" => Some("move({ACTION,direction='r'})"),
        "move-tile-up" => Some("move({ACTION,direction='u'})"),
        "move-tile-down" => Some("move({ACTION,direction='d'})"),
        _ => None,
    };
    if let Some(dispatch) = dispatch {
        remember(&client)?;
        if operation == "toggle-pin" && !client.floating {
            float_window(&target)?;
        }
        return eval(&format!(
            "hl.dispatch(hl.dsp.window.{})",
            dispatch.replace("ACTION", &format!("window={target:?}"))
        ));
    }
    let rect =
        tile_rect(area, operation).or_else(|_| relative_rect(area, client.rect(), operation))?;
    remember(&client)?;
    float_window(&target)?;
    place(&target, rect)
}

fn operation_icon(operation: &str) -> &'static str {
    match operation {
        "left-half" | "left-third" | "left-two-thirds" | "first-fourth" => {
            "icon:AppWindowSidebarLeft"
        }
        "right-half" | "right-third" | "right-two-thirds" | "last-fourth" => {
            "icon:AppWindowSidebarRight"
        }
        "move-left" | "move-tile-left" | "previous-workspace" | "previous-display" => {
            "icon:ArrowLeft"
        }
        "move-right" | "move-tile-right" | "next-workspace" | "next-display" => "icon:ArrowRight",
        "move-up" | "move-tile-up" | "top-half" | "top-third" | "top-two-thirds" => "icon:ArrowUp",
        "move-down" | "move-tile-down" | "bottom-half" | "bottom-third" | "bottom-two-thirds" => {
            "icon:ArrowDown"
        }
        "top-left" | "top-left-sixth" => "icon:ArrowUpLeft",
        "top-right" | "top-right-sixth" => "icon:ArrowUpRight",
        "bottom-left" | "bottom-left-sixth" => "icon:ArrowDownLeft",
        "bottom-right" | "bottom-right-sixth" => "icon:ArrowDownRight",
        "maximize" | "maximize-width" | "maximize-height" | "larger" | "resize-window" => {
            "icon:ArrowsExpand"
        }
        "smaller" | "reasonable-size" => "icon:ArrowsContract",
        "toggle-fullscreen" => "icon:Maximize",
        "restore" => "icon:ArrowCounterClockwise",
        "toggle-pin" => "icon:Pin",
        "tile" => "icon:AppWindowGrid2x2",
        "float" | "toggle-floating" | "scratchpad" => "icon:Layers",
        "move-window" | "center" => "icon:Move",
        _ => "icon:AppWindowGrid3x3",
    }
}

pub fn entries() -> Vec<Entry> {
    let extra = [
        ("center", "Center Window"),
        ("reasonable-size", "Reasonable Size"),
        ("maximize-width", "Maximize Width"),
        ("maximize-height", "Maximize Height"),
        ("larger", "Make Window Larger"),
        ("smaller", "Make Window Smaller"),
        ("move-left", "Move Window Left"),
        ("move-right", "Move Window Right"),
        ("move-up", "Move Window Up"),
        ("move-down", "Move Window Down"),
        ("restore", "Restore Window"),
        ("toggle-fullscreen", "Toggle Fullscreen"),
        ("float", "Float Window"),
        ("tile", "Tile Window"),
        ("toggle-floating", "Toggle Floating"),
        ("toggle-pin", "Toggle Window Pinning"),
        ("next-display", "Move to Next Display"),
        ("previous-display", "Move to Previous Display"),
        ("next-workspace", "Move to Next Workspace"),
        ("previous-workspace", "Move to Previous Workspace"),
        ("scratchpad", "Move to Scratchpad"),
        ("move-tile-left", "Move Tile Left"),
        ("move-tile-right", "Move Tile Right"),
        ("move-tile-up", "Move Tile Up"),
        ("move-tile-down", "Move Tile Down"),
    ];
    let mut entries = POSITIONS
        .iter()
        .chain(extra.iter())
        .map(|(operation, title)| {
            Entry::new(
                &format!("window:{operation}"),
                title,
                "Window Management · Hyprland",
                operation_icon(operation),
                Action::Window {
                    operation: operation.to_string(),
                    target: String::new(),
                },
            )
        })
        .collect::<Vec<_>>();
    for workspace in 1..=10 {
        entries.push(Entry::new(
            &format!("window:workspace:{workspace}"),
            &format!("Move to Workspace {workspace}"),
            "Move the previously focused window",
            "icon:Desktop",
            Action::Window {
                operation: format!("workspace:{workspace}"),
                target: String::new(),
            },
        ));
    }
    for (command, title) in [
        ("move-window", "Move Window"),
        ("resize-window", "Resize Window"),
    ] {
        entries.push(Entry::new(
            &format!("window:{command}"),
            title,
            "Set an exact position or size",
            operation_icon(command),
            Action::Extension {
                extension: "omarchy-tools".into(),
                command: command.into(),
            },
        ));
    }
    entries.push(Entry::new(
        "quit-all",
        "Quit All Applications",
        "Request each application to close its windows",
        "󰅖",
        Action::Builtin("quit-all".into()),
    ));
    entries
}

pub fn running_entries() -> Vec<Entry> {
    clients()
        .into_iter()
        .flat_map(|c| {
            [
                Entry::new(
                    &format!("focus:{}", c.id),
                    &c.title,
                    &c.class,
                    "󰖯",
                    Action::Window {
                        operation: "focus".into(),
                        target: c.id.clone(),
                    },
                ),
                Entry::new(
                    &format!("quit:{}", c.id),
                    &format!("Quit {}", c.class),
                    &c.title,
                    "󰅖",
                    Action::Window {
                        operation: "close".into(),
                        target: c.id,
                    },
                ),
            ]
        })
        .collect()
}

pub fn paste() -> Result<(), String> {
    eval(
        "local mods,key='CTRL','V'; local active=hl.get_active_window(); if active then for _,tag in ipairs(active.tags or {}) do if tag:gsub('%*$','')=='terminal' then mods,key='SHIFT','Insert' end end end; hl.dispatch(hl.dsp.send_key_state({mods=mods,key=key,state='down'})); hl.timer(function() hl.dispatch(hl.dsp.send_key_state({mods=mods,key=key,state='up'})) end,{timeout=50,type='oneshot'})",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_raise_targets_only_the_current_process_mapped_launcher() {
        let windows = serde_json::json!([
            {"mapped":true,"class":"command-space","pid":12,"stableId":"abc1"},
            {"mapped":true,"class":"command-space","pid":12,"stableId":"abc2"},
            {"mapped":true,"class":"command-space","pid":34,"stableId":"abc3"},
            {"mapped":true,"class":"terminal","pid":12,"stableId":"abc4"},
            {"mapped":false,"class":"command-space","pid":12,"stableId":"abc5"}
        ]);
        assert_eq!(launcher_target(&windows, 12).unwrap(), "stableid:abc2");
        assert!(launcher_target(&windows, 56).is_err());
        assert!(launcher_target(&Value::Null, 12).is_err());
    }
    #[test]
    fn monitor_scale_rotation_and_reserved_space() {
        let monitor = serde_json::json!({"width":2160,"height":3840,"scale":2,"transform":1,"x":-1920,"y":0,"reserved":[0,30,0,10]});
        assert_eq!(
            monitor_rect(&monitor, true),
            Rect {
                x: -1920.0,
                y: 30.0,
                width: 1920.0,
                height: 1040.0
            }
        );
    }
    #[test]
    fn tiling_accounts_for_monitor_origin_and_work_area() {
        let area = Rect {
            x: -1200.0,
            y: 28.0,
            width: 1200.0,
            height: 900.0,
        };
        assert_eq!(
            tile_rect(area, "bottom-right").unwrap(),
            Rect {
                x: -600.0,
                y: 478.0,
                width: 600.0,
                height: 450.0
            }
        );
        assert_eq!(
            tile_rect(area, "center-third").unwrap(),
            Rect {
                x: -800.0,
                y: 28.0,
                width: 400.0,
                height: 900.0
            }
        );
    }
    #[test]
    fn launcher_fits_small_displays() {
        let context = Context {
            previous: None,
            monitor: serde_json::json!({"width":1008,"height":568,"scale":2,"reserved":[0,26,0,0]}),
        };
        let rect = context.launcher_rect(&Config::default());
        assert_eq!(
            rect,
            Rect {
                x: 12.0,
                y: 38.0,
                width: 480.0,
                height: 234.0
            }
        );
    }

    #[test]
    fn hexadecimal_window_ids_and_fractional_regions_are_supported() {
        assert_eq!(selector("1800004a").unwrap(), "stableid:1800004a");
        for invalid in ["", "activewindow", "1;quit", "1-2"] {
            assert!(selector(invalid).is_err());
        }
        let area = Rect {
            x: -1351.0,
            y: 31.0,
            width: 2702.0,
            height: 1995.0,
        };
        for positions in [
            vec!["left-third", "center-third", "right-third"],
            vec![
                "first-fourth",
                "second-fourth",
                "third-fourth",
                "last-fourth",
            ],
        ] {
            let regions = positions
                .into_iter()
                .map(|position| tile_rect(area, position).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(regions.first().unwrap().x, area.x);
            assert_eq!(
                regions.last().unwrap().x + regions.last().unwrap().width,
                area.x + area.width
            );
            assert!(
                regions
                    .windows(2)
                    .all(|pair| pair[0].x + pair[0].width == pair[1].x)
            );
        }
        assert_eq!(
            tile_rect(area, "bottom-center-sixth").unwrap(),
            Rect {
                x: -450.0,
                y: 1029.0,
                width: 900.0,
                height: 997.0
            }
        );
    }

    #[test]
    fn relative_moves_and_display_changes_respect_work_areas() {
        let source = Rect {
            x: -1920.0,
            y: 30.0,
            width: 1920.0,
            height: 1050.0,
        };
        let current = Rect {
            x: -1600.0,
            y: 130.0,
            width: 800.0,
            height: 500.0,
        };
        assert_eq!(
            relative_rect(source, current, "move-right").unwrap(),
            Rect {
                x: -800.0,
                ..current
            }
        );
        assert_eq!(
            relative_rect(source, current, "center").unwrap(),
            Rect {
                x: -1360.0,
                y: 305.0,
                ..current
            }
        );
        assert_eq!(
            relative_rect(source, current, "maximize-height").unwrap(),
            Rect {
                y: 30.0,
                height: 1050.0,
                ..current
            }
        );
        let reasonable = relative_rect(source, current, "reasonable-size").unwrap();
        assert_eq!(reasonable.width, 1025.0);
        assert_eq!(reasonable.height, 630.0);
        let destination = Rect {
            x: 0.0,
            y: 0.0,
            width: 960.0,
            height: 525.0,
        };
        assert_eq!(
            display_rect(current, source, destination),
            Rect {
                x: 160.0,
                y: 50.0,
                width: 400.0,
                height: 250.0
            }
        );
        assert_eq!(
            workspace_selector(&Workspace {
                id: 13,
                name: "Development".into()
            }),
            "name:Development"
        );
        assert_eq!(
            workspace_selector(&Workspace {
                id: -98,
                name: "special:scratchpad".into()
            }),
            "special:scratchpad"
        );
    }
}
