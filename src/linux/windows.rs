use super::model::{Action, Config, Entry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
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

pub const POSITIONS: [(&str, &str); 12] = [
    ("left-half", "Left Half"),
    ("right-half", "Right Half"),
    ("top-half", "Top Half"),
    ("bottom-half", "Bottom Half"),
    ("top-left", "Top Left Quarter"),
    ("top-right", "Top Right Quarter"),
    ("bottom-left", "Bottom Left Quarter"),
    ("bottom-right", "Bottom Right Quarter"),
    ("left-third", "Left Third"),
    ("center-third", "Center Third"),
    ("right-third", "Right Third"),
    ("maximize", "Maximize"),
];

pub fn tile_rect(area: Rect, operation: &str) -> Result<Rect, String> {
    let (x, y, width, height) = match operation {
        "left-half" => (0.0, 0.0, 0.5, 1.0),
        "right-half" => (0.5, 0.0, 0.5, 1.0),
        "top-half" => (0.0, 0.0, 1.0, 0.5),
        "bottom-half" => (0.0, 0.5, 1.0, 0.5),
        "top-left" => (0.0, 0.0, 0.5, 0.5),
        "top-right" => (0.5, 0.0, 0.5, 0.5),
        "bottom-left" => (0.0, 0.5, 0.5, 0.5),
        "bottom-right" => (0.5, 0.5, 0.5, 0.5),
        "left-third" => (0.0, 0.0, 1.0 / 3.0, 1.0),
        "center-third" => (1.0 / 3.0, 0.0, 1.0 / 3.0, 1.0),
        "right-third" => (2.0 / 3.0, 0.0, 1.0 / 3.0, 1.0),
        "maximize" => (0.0, 0.0, 1.0, 1.0),
        _ => return Err(format!("Unknown window position: {operation}")),
    };
    Ok(Rect {
        x: (area.x + area.width * x).round(),
        y: (area.y + area.height * y).round(),
        width: (area.width * width).round(),
        height: (area.height * height).round(),
    })
}

fn selector(id: &str) -> Result<String, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Window is no longer available".into());
    }
    Ok(format!("stableid:{id}"))
}

pub fn place(selector: &str, rect: Rect) -> Result<(), String> {
    let target = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    eval(&format!(
        "hl.dispatch(hl.dsp.window.resize({{window={target},x={},y={},relative=false}})); hl.dispatch(hl.dsp.window.move({{window={target},x={},y={},relative=false}}))",
        rect.width as i32, rect.height as i32, rect.x as i32, rect.y as i32
    ))
}

pub fn operate(operation: &str, id: &str) -> Result<(), String> {
    let target = selector(id)?;
    let client = clients()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("The selected window has closed")?;
    if operation == "close" {
        return eval(&format!(
            "hl.dispatch(hl.dsp.window.close({{window={target:?}}}))"
        ));
    }
    if operation == "focus" {
        return eval(&format!("hl.dispatch(hl.dsp.focus({{window={target:?}}}))"));
    }
    let monitors = query("monitors")?;
    let monitor = monitors
        .as_array()
        .and_then(|m| m.iter().find(|m| m["id"] == client.monitor))
        .ok_or("Window monitor unavailable")?;
    let rect = tile_rect(monitor_rect(monitor, true), operation)?;
    eval(&format!(
        "hl.dispatch(hl.dsp.window.fullscreen({{window={target:?},action='unset'}})); hl.dispatch(hl.dsp.window.float({{window={target:?},action='enable'}}))"
    ))?;
    place(&target, rect)?;
    operate("focus", id)
}

pub fn entries() -> Vec<Entry> {
    let mut entries = POSITIONS
        .iter()
        .map(|(operation, title)| {
            Entry::new(
                &format!("window:{operation}"),
                title,
                "Arrange the previously focused window",
                "󰖯",
                Action::Window {
                    operation: operation.to_string(),
                    target: String::new(),
                },
            )
        })
        .collect::<Vec<_>>();
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
}
