use super::{
    extensions::{self, Node, Session},
    model::data_dir,
    windows,
};
use ksni::{
    MenuItem,
    blocking::TrayMethods,
    menu::{StandardItem, SubMenu},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    sync::mpsc,
    time::{Duration, Instant},
};

pub struct Worker {
    pub session: Session,
    tray: TrayHandle,
    refresh_at: Option<Instant>,
    interval: Option<Duration>,
    source_stamp: Option<std::time::SystemTime>,
}

impl Worker {
    pub fn new(session: Session) -> Self {
        let interval = extensions::manifest(&extensions::root().join(&session.extension))
            .ok()
            .and_then(|m| m.commands.into_iter().find(|c| c.name == session.command))
            .and_then(|c| c.interval.as_deref().and_then(parse_interval));
        let source_stamp = fs::metadata(
            extensions::root()
                .join(&session.extension)
                .join("package.json"),
        )
        .and_then(|m| m.modified())
        .ok();
        Self {
            tray: TrayHandle::new(
                session.id,
                format!("{} · {}", session.extension, session.command),
            ),
            session,
            refresh_at: interval.map(|d| Instant::now() + d),
            interval,
            source_stamp,
        }
    }

    pub fn render(&self, root: Option<Node>) {
        self.tray.send(root);
    }

    pub fn refresh(&mut self, background: bool) -> Result<(), String> {
        self.refresh_at = self.interval.map(|d| Instant::now() + d);
        self.session.refresh(background)
    }

    pub fn launch(
        &mut self,
        background: bool,
        arguments: Value,
        context: Value,
    ) -> Result<(), String> {
        self.launch_with_fallback(background, arguments, context, None)
    }

    pub fn launch_with_fallback(
        &mut self,
        background: bool,
        arguments: Value,
        context: Value,
        fallback_text: Option<&str>,
    ) -> Result<(), String> {
        self.refresh_at = self.interval.map(|d| Instant::now() + d);
        self.session
            .launch(arguments, context, background, fallback_text)
    }

    pub fn tick(&mut self) {
        let stamp = fs::metadata(
            extensions::root()
                .join(&self.session.extension)
                .join("package.json"),
        )
        .and_then(|m| m.modified())
        .ok();
        let changed = stamp != self.source_stamp;
        self.source_stamp = stamp;
        if (changed || self.refresh_at.is_some_and(|at| Instant::now() >= at))
            && let Err(error) = self.refresh(true)
        {
            eprintln!("Background extension: {error}");
        }
    }
    pub fn scheduled(&self) -> bool {
        self.interval.is_some()
    }
}

fn parse_interval(value: &str) -> Option<Duration> {
    let (number, unit) = value.split_at(value.find(|c: char| !c.is_ascii_digit())?);
    let seconds = number.parse::<u64>().ok()?.checked_mul(match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => return None,
    })?;
    (seconds > 0).then(|| Duration::from_secs(seconds.max(10)))
}

pub fn enabled() -> BTreeSet<String> {
    fs::read(data_dir().join("background.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn set_enabled(extension: &str, command: &str, active: bool) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut values = enabled();
    let key = format!("{extension}/{command}");
    if active {
        values.insert(key);
    } else {
        values.remove(&key);
    }
    fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    let target = data_dir().join("background.json");
    let temp = target.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&values).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(temp, target).map_err(|e| e.to_string())
}

pub fn restore() -> HashMap<u64, Worker> {
    enabled()
        .into_iter()
        .filter_map(|key| {
            let (extension, command) = key.split_once('/')?;
            match Session::start_with_options(
                extension,
                command,
                Value::Null,
                Value::Null,
                &windows::Context::default(),
                true,
            ) {
                Ok(session) => Some((session.id, Worker::new(session))),
                Err(error) => {
                    eprintln!("Restoring {key}: {error}");
                    None
                }
            }
        })
        .collect()
}

pub fn menu_root(nodes: &[Node]) -> Option<Node> {
    nodes
        .iter()
        .flat_map(Node::descendants)
        .find(|n| n.kind == "MenuBarExtra")
        .cloned()
}

enum TrayUpdate {
    Render(Option<Node>),
    Stop,
}
struct TrayHandle(mpsc::Sender<TrayUpdate>);

impl TrayHandle {
    fn new(id: u64, name: String) -> Self {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut handle: Option<ksni::blocking::Handle<ExtensionTray>> = None;
            for update in receiver {
                match update {
                    TrayUpdate::Render(Some(root)) => {
                        if let Some(handle) = &handle {
                            handle.update(|tray| tray.root = root);
                        } else {
                            match (ExtensionTray {
                                id,
                                name: name.clone(),
                                root,
                            })
                            .assume_sni_available(true)
                            .spawn()
                            {
                                Ok(tray) => handle = Some(tray),
                                Err(error) => eprintln!("Extension tray: {error}"),
                            }
                        }
                    }
                    TrayUpdate::Render(None) => {
                        if let Some(tray) = handle.take() {
                            tray.shutdown().wait();
                        }
                    }
                    TrayUpdate::Stop => break,
                }
            }
            if let Some(tray) = handle {
                tray.shutdown().wait();
            }
        });
        Self(sender)
    }
    fn send(&self, root: Option<Node>) {
        let _ = self.0.send(TrayUpdate::Render(root));
    }
}
impl Drop for TrayHandle {
    fn drop(&mut self) {
        let _ = self.0.send(TrayUpdate::Stop);
    }
}

struct ExtensionTray {
    id: u64,
    name: String,
    root: Node,
}

fn label(value: &str) -> String {
    value.replace('_', "__")
}

fn icon_path(node: &Node) -> String {
    let value = &node.props["icon"];
    value
        .as_str()
        .or_else(|| value["source"].as_str())
        .filter(|p| p.starts_with('/'))
        .unwrap_or_default()
        .into()
}

fn shortcut(node: &Node) -> Vec<Vec<String>> {
    let value = &node.props["shortcut"];
    let Some(key) = value["key"].as_str() else {
        return vec![];
    };
    let mut keys = value["modifiers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| match m.as_str()? {
            "cmd" | "ctrl" => Some("Control".into()),
            "opt" | "alt" => Some("Alt".into()),
            "shift" => Some("Shift".into()),
            _ => None,
        })
        .collect::<Vec<_>>();
    keys.push(key.into());
    vec![keys]
}

fn menu_nodes(nodes: &[Node], id: u64) -> Vec<MenuItem<ExtensionTray>> {
    let mut items = vec![];
    for node in nodes {
        let title = label(node.text("title"));
        match node.kind.as_str() {
            "MenuBarExtra.Separator" => items.push(MenuItem::Separator),
            "MenuBarExtra.Section" => {
                if !items.is_empty() {
                    items.push(MenuItem::Separator);
                }
                if !title.is_empty() {
                    items.push(
                        StandardItem {
                            label: title,
                            enabled: false,
                            ..Default::default()
                        }
                        .into(),
                    );
                }
                items.extend(menu_nodes(&node.children, id));
            }
            "MenuBarExtra.Submenu" => items.push(
                SubMenu {
                    label: title,
                    submenu: menu_nodes(&node.children, id),
                    icon_name: icon_path(node),
                    icon_data: super::tray_image::render(&node.props["icon"])
                        .map(|i| i.png())
                        .unwrap_or_default(),
                    ..Default::default()
                }
                .into(),
            ),
            "MenuBarExtra.Item" => {
                let callback = node.callback("onAction");
                let enabled =
                    callback.is_some() && !node.props["disabled"].as_bool().unwrap_or(false);
                let callback = callback.unwrap_or_default();
                items.push(
                    StandardItem {
                        label: title,
                        enabled,
                        icon_name: icon_path(node),
                        icon_data: super::tray_image::render(&node.props["icon"])
                            .map(|i| i.png())
                            .unwrap_or_default(),
                        shortcut: shortcut(node),
                        activate: Box::new(move |_| {
                            extensions::emit(id, json!({"type":"tray-action","callback":callback}))
                        }),
                        ..Default::default()
                    }
                    .into(),
                );
                if let Ok(alternate) =
                    serde_json::from_value::<Node>(node.props["alternate"].clone())
                {
                    items.extend(menu_nodes(&[alternate], id));
                }
            }
            _ => items.extend(menu_nodes(&node.children, id)),
        }
    }
    items
}

impl ksni::Tray for ExtensionTray {
    const MENU_ON_ACTIVATE: bool = true;
    fn id(&self) -> String {
        format!("super-space-extension-{}", self.id)
    }
    fn title(&self) -> String {
        if self.root.text("title").is_empty() {
            self.name.clone()
        } else {
            self.root.text("title").into()
        }
    }
    fn icon_name(&self) -> String {
        icon_path(&self.root)
    }
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        super::tray_image::render(&self.root.props["icon"])
            .map(|image| image.pixmap())
            .unwrap_or_else(super::tray::launcher_icon)
    }
    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: self.title(),
            description: self.root.text("tooltip").into(),
            ..Default::default()
        }
    }
    fn menu(&self) -> Vec<MenuItem<Self>> {
        let mut items = vec![
            StandardItem {
                label: label(&self.title()),
                enabled: false,
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
        ];
        items.extend(menu_nodes(&self.root.children, self.id));
        if !items.is_empty() {
            items.push(MenuItem::Separator);
        }
        for (label, operation) in [
            ("Refresh", "tray-refresh"),
            ("Preferences", "tray-preferences"),
            ("Stop Extension", "tray-stop"),
        ] {
            let id = self.id;
            items.push(
                StandardItem {
                    label: label.into(),
                    activate: Box::new(move |_| extensions::emit(id, json!({"type":operation}))),
                    ..Default::default()
                }
                .into(),
            );
        }
        items
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_intervals_are_bounded_and_validated() {
        assert_eq!(parse_interval("5m"), Some(Duration::from_secs(300)));
        assert_eq!(parse_interval("1s"), Some(Duration::from_secs(10)));
        assert_eq!(parse_interval("2h"), Some(Duration::from_secs(7200)));
        for value in ["0s", "-1m", "1.5m", "5", "1w", "18446744073709551615d"] {
            assert_eq!(parse_interval(value), None);
        }
    }
    #[test]
    fn native_menu_preserves_nested_actions_and_disabled_labels() {
        let tree: Vec<Node> = serde_json::from_value(json!([{"type":"MenuBarExtra.Section","props":{"title":"Items"},"children":[
            {"type":"MenuBarExtra.Item","props":{"title":"Status_only"}},
            {"type":"MenuBarExtra.Submenu","props":{"title":"More"},"children":[{"type":"MenuBarExtra.Item","props":{"title":"Run","onAction":{"$callback":"42"},"shortcut":{"modifiers":["cmd"],"key":"r"}}}]}
        ]}])).unwrap();
        let menu = menu_nodes(&tree, 7);
        assert_eq!(menu.len(), 3);
        match &menu[1] {
            MenuItem::Standard(item) => {
                assert!(!item.enabled);
                assert_eq!(item.label, "Status__only");
            }
            _ => panic!("Expected label"),
        }
        match &menu[2] {
            MenuItem::SubMenu(item) => assert_eq!(item.submenu.len(), 1),
            _ => panic!("Expected submenu"),
        }
    }
}
