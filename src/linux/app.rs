use super::{
    appearance::Colors,
    catalog::{self, Catalog},
    desktop,
    model::{Action, Config, Entry, config_dir, shell_quote},
    windows,
};
use iced::{
    Element,
    Length::{Fill, Fixed},
    Subscription, Task,
    keyboard::{self, Key, key::Named},
    widget::{self, button, column, container, row, scrollable, text, text_input},
    window,
};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[derive(Clone, Debug)]
pub enum Message {
    Loaded(Catalog),
    Query(String),
    Move(i32),
    Activate(usize),
    Submit,
    Back,
    Hide,
    Show(String, bool),
    Opened(window::Id),
    Dynamic(String, Vec<Entry>),
    Files(String, Vec<Entry>),
    Detail(String, String),
    Result(Result<(), String>),
    Actions,
    ActionChoice(usize),
    ActionSubmenu(String),
    ActionQuery(String),
    Favorite,
    CopyTitle,
    Run(Action),
    Reload,
    Quit,
    Setting(String, String),
    SaveSettings,
    AiKey(String, bool),
    CancelSettings,
    EntryAction(String),
    Tick,
    Monitors(serde_json::Value),
    DeepLink(String),
    Key(Key, keyboard::Modifiers, bool),
    Url(String),
    Extension(u64, serde_json::Value),
    BackgroundResponse(u64, String, Result<serde_json::Value, String>),
    ExtensionInvoke(String, Vec<serde_json::Value>),
    ExtensionField(String, serde_json::Value, Option<String>),
    ExtensionFocus(String),
    ExtensionEdit(String, widget::text_editor::Action, Option<String>),
    ExtensionPick(String, serde_json::Value),
    ExtensionDate(String, serde_json::Value),
    ExtensionPicked(u64, String, serde_json::Value, Option<String>),
    ExtensionInstalled(Result<String, String>),
    UpdateChecked(bool, Result<super::updates::Release, String>),
    UpdateStarted(Result<(), String>),
    AlertResponse(bool),
    Noop,
}

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

pub struct Launcher {
    release: Option<super::updates::Release>,
    next_update_check: std::time::Instant,
    backgrounds: std::collections::HashMap<u64, super::background::Worker>,
    background_oauth: std::collections::HashMap<u64, (String, String)>,
    restored_backgrounds: bool,
    oauth: Option<(String, String)>,
    pending_link: Option<String>,
    extension_queries: std::collections::HashMap<String, (String, usize)>,
    installing: bool,
    context: windows::Context,
    settings: Option<super::settings::Editor>,
    config_stamp: Option<std::time::SystemTime>,
    file_generation: Arc<AtomicU64>,
    extension: Option<super::extensions::Session>,
    extension_view: super::extension_view::ExtensionView,
    alert: Option<(String, serde_json::Value)>,
    config: Config,
    catalog: Catalog,
    colors: Colors,
    route: String,
    query: String,
    results: Vec<Entry>,
    selected: usize,
    stack: Vec<(String, String, usize)>,
    dynamic: Vec<Entry>,
    window: Option<window::Id>,
    loading: bool,
    status: String,
    actions: bool,
    action_selected: usize,
    action_path: Vec<String>,
    action_query: String,
    detail: Option<(String, Vec<widget::markdown::Item>)>,
}

impl Launcher {
    fn panel_items(&self) -> Vec<(String, Message)> {
        let mut items = if self.extension.is_some() {
            self.extension_view
                .panel_nodes(
                    self.results
                        .get(self.selected)
                        .map(|entry| entry.id.as_str()),
                    self.action_path.last().map(String::as_str),
                )
                .into_iter()
                .map(|node| {
                    if node.kind == "ActionPanel.Submenu" {
                        (
                            format!("{}  ›", node.text("title")),
                            Message::ActionSubmenu(node.id.clone()),
                        )
                    } else {
                        (
                            node.text("title").into(),
                            self.extension_view.action_message(node),
                        )
                    }
                })
                .collect()
        } else {
            vec![
                ("Open".into(), Message::Submit),
                ("Toggle favorite".into(), Message::Favorite),
                ("Copy title".into(), Message::CopyTitle),
            ]
        };
        if self.extension.is_none() {
            let specific: &[(&str, &str)] = match self.route.as_str() {
                "clipboard" => &[
                    ("Copy", "copy"),
                    ("Paste into previous app", "paste"),
                    ("Delete item", "delete"),
                    ("Clear history", "clear-clipboard"),
                ],
                "files" => &[
                    ("Preview", "preview"),
                    ("Show in file manager", "reveal"),
                    ("Copy path", "copy"),
                    ("Move to Trash", "delete"),
                ],
                _ => &[],
            };
            items.extend(specific.iter().map(|(title, operation)| {
                ((*title).into(), Message::EntryAction((*operation).into()))
            }));
        }
        items.retain(|(title, _)| {
            title
                .to_lowercase()
                .contains(&self.action_query.to_lowercase())
        });
        items
    }

    fn focus_input(&self) -> Task<Message> {
        if self.extension.is_some()
            && self
                .extension_view
                .root()
                .is_some_and(|node| node.kind == "Form")
        {
            let fields = self.extension_view.form_fields();
            let field = fields
                .iter()
                .find(|node| node.text("id") == self.extension_view.focused)
                .copied()
                .or_else(|| {
                    fields
                        .into_iter()
                        .min_by_key(|node| !node.props["autoFocus"].as_bool().unwrap_or(false))
                });
            return field.map_or(Task::none(), |node| {
                Task::done(Message::ExtensionFocus(node.text("id").into()))
            });
        }
        let field = self
            .extension_view
            .nodes
            .iter()
            .flat_map(super::extensions::Node::descendants)
            .filter(|node| {
                matches!(
                    node.kind.as_str(),
                    "Form.TextField" | "Form.PasswordField" | "Form.TextArea" | "Form.DatePicker"
                )
            })
            .min_by_key(|node| !node.props["autoFocus"].as_bool().unwrap_or(false))
            .map(|node| format!("field:{}", node.text("id")))
            .unwrap_or_else(|| "search".into());
        widget::operation::focus(widget::Id::from(field))
    }

    pub fn new(initial: Option<String>) -> (Self, Task<Message>) {
        let pending_link = initial
            .as_ref()
            .and_then(|v| v.strip_prefix("link:"))
            .map(String::from);
        let initial = if pending_link.is_some() {
            Some("root".into())
        } else {
            initial
        };
        let (config, status) = match Config::load() {
            Ok(c) => (c, String::new()),
            Err(e) => (Config::default(), format!("Configuration: {e}")),
        };
        let mut launcher = Self {
            release: None,
            next_update_check: std::time::Instant::now() + std::time::Duration::from_secs(86400),
            backgrounds: Default::default(),
            background_oauth: Default::default(),
            restored_backgrounds: false,
            oauth: None,
            pending_link,
            extension_queries: Default::default(),
            installing: false,
            context: windows::Context::default(),
            settings: None,
            config_stamp: std::fs::metadata(config_dir().join("config.toml"))
                .and_then(|m| m.modified())
                .ok(),
            file_generation: Arc::new(AtomicU64::new(0)),
            extension: None,
            extension_view: Default::default(),
            alert: None,
            colors: Colors::configured(&config),
            config,
            catalog: Catalog::default(),
            route: "root".into(),
            query: String::new(),
            results: vec![],
            selected: 0,
            stack: vec![],
            dynamic: vec![],
            window: None,
            loading: true,
            status,
            actions: false,
            action_selected: 0,
            action_path: Vec::new(),
            action_query: String::new(),
            detail: None,
        };
        launcher.rebuild();
        let load = Self::load();
        let updates = if launcher.config.check_updates {
            Task::perform(super::updates::check(), |result| {
                Message::UpdateChecked(false, result)
            })
        } else {
            Task::none()
        };
        let show = initial.map_or(Task::none(), |route| launcher.show(&route, false));
        (launcher, Task::batch([load, show, updates]))
    }

    fn load() -> Task<Message> {
        Task::perform(
            async {
                tokio::task::spawn_blocking(Catalog::load)
                    .await
                    .unwrap_or_default()
            },
            Message::Loaded,
        )
    }

    fn rebuild(&mut self) {
        let selected_id = self.results.get(self.selected).map(|e| e.id.clone());
        if self.extension.is_some() {
            self.results = self.extension_view.entries(&self.query);
            self.selected = self.selected.min(self.results.len().saturating_sub(1));
            return;
        }
        self.results = if self.route == "packages"
            || self.route.starts_with("extension-manage:")
            || self.route == "running"
            || self.route == "updates"
            || self.route.starts_with("mode:")
        {
            let mut catalog = self.catalog.clone();
            catalog.apps = self.dynamic.clone();
            catalog.search("apps", &self.query, &self.config, &[])
        } else {
            self.catalog
                .search(&self.route, &self.query, &self.config, &self.dynamic)
        };
        self.selected = self.selected.min(self.results.len().saturating_sub(1));
        if self.route == "clipboard"
            && let Some(index) = self
                .results
                .iter()
                .position(|e| Some(&e.id) == selected_id.as_ref())
        {
            self.selected = index;
        }
    }

    fn show(&mut self, route: &str, toggle: bool) -> Task<Message> {
        let next = route
            .strip_prefix("builtin:")
            .map(String::from)
            .unwrap_or_else(|| self.catalog.menu.resolve(route));
        if toggle && self.window.is_some() && self.route == next {
            return self.hide();
        }
        self.extension = None;
        self.oauth = None;
        self.extension_queries.clear();
        self.settings = None;
        self.alert = None;
        self.extension_view = Default::default();
        if let Ok(config) = Config::load() {
            self.config = config;
        }
        self.colors = Colors::configured(&self.config);
        self.status = self.catalog.errors.join("; ");
        if self.config.clear_on_hide || next != self.route {
            self.query.clear();
        }
        self.route = next;
        self.stack.clear();
        self.dynamic.clear();
        self.detail = None;
        self.actions = false;
        self.selected = 0;
        if self.route == "settings" {
            self.settings = Some(super::settings::Editor::new(&self.config));
        }
        self.rebuild();
        if let Some(id) = self.window {
            return Task::batch([
                window::gain_focus(id),
                widget::operation::focus("search"),
                self.load_dynamic(),
            ]);
        }
        self.context = windows::Context::capture(self.config.follow_mouse);
        self.present()
    }

    fn present(&mut self) -> Task<Message> {
        if let Some(id) = self.window {
            return window::gain_focus(id);
        }
        let rect = self.context.launcher_rect(&self.config);
        let (id, open) = window::open(window::Settings {
            size: iced::Size::new(rect.width, rect.height),
            position: window::Position::Centered,
            resizable: false,
            decorations: false,
            transparent: false,
            level: window::Level::AlwaysOnTop,
            exit_on_close_request: false,
            platform_specific: window::settings::PlatformSpecific {
                application_id: "command-space".into(),
                ..Default::default()
            },
            ..Default::default()
        });
        self.window = Some(id);
        let refresh = if self.loading {
            Task::none()
        } else {
            self.loading = true;
            Self::load()
        };
        Task::batch([open.map(Message::Opened), self.load_dynamic(), refresh])
    }

    fn hide(&mut self) -> Task<Message> {
        self.file_generation.fetch_add(1, Ordering::Relaxed);
        self.actions = false;
        self.settings = None;
        if self.config.clear_on_hide {
            self.query.clear();
        }
        self.window.take().map_or(Task::none(), window::close)
    }

    fn enter(&mut self, route: String) -> Task<Message> {
        self.file_generation.fetch_add(1, Ordering::Relaxed);
        self.stack
            .push((self.route.clone(), self.query.clone(), self.selected));
        self.route = route;
        self.query.clear();
        self.selected = 0;
        self.dynamic.clear();
        self.detail = None;
        self.actions = false;
        if self.route == "settings" {
            self.settings = Some(super::settings::Editor::new(&self.config));
        }
        self.rebuild();
        self.load_dynamic()
    }

    fn load_dynamic(&self) -> Task<Message> {
        if self.route == "updates" {
            return Task::batch([
                widget::operation::focus("search"),
                Task::perform(super::updates::check(), |result| {
                    Message::UpdateChecked(true, result)
                }),
            ]);
        }
        let menu = self.catalog.menu.clone();
        let route = self.route.clone();
        Task::batch([
            widget::operation::focus("search"),
            Task::perform(
                async move {
                    let key = route.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        if route.starts_with("extension-manage:") {
                            super::extensions::management_entries(&route)
                        } else if route == "running" {
                            windows::running_entries()
                        } else if route == "packages" {
                            catalog::packages()
                        } else {
                            menu.provider(&route)
                        }
                    })
                    .await
                    .unwrap_or_default();
                    (key, result)
                },
                |(key, result)| Message::Dynamic(key, result),
            ),
        ])
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::UpdateChecked(manual, result) => match result {
                Ok(release) => {
                    if self.route == "updates" {
                        self.dynamic = super::updates::entries(&release);
                        self.rebuild();
                    }
                    if manual || release.available {
                        self.status = release.message.clone();
                    }
                    self.release = Some(release);
                }
                Err(error) if manual => self.status = error,
                Err(_) => {}
            },
            Message::UpdateStarted(result) => {
                self.status = match result {
                    Ok(()) => {
                        "Downloading update. Command Space will restart when it is ready.".into()
                    }
                    Err(error) => error,
                };
            }
            Message::Loaded(catalog) => {
                if !self.restored_backgrounds {
                    self.restored_backgrounds = true;
                    self.backgrounds = super::background::restore();
                }
                self.loading = false;
                if !catalog.errors.is_empty() {
                    self.status = catalog.errors.join("; ");
                }
                if self.catalog.menu.items.is_empty() && !catalog::is_builtin_route(&self.route) {
                    self.route = catalog.menu.resolve(&self.route);
                }
                self.catalog = catalog;
                self.rebuild();
                if let Some(link) = self.pending_link.take() {
                    return self.update(Message::DeepLink(link));
                }
                return self.load_dynamic();
            }
            Message::Opened(id) => {
                if self.window != Some(id) {
                    return window::close(id);
                }
                let rect = self.context.launcher_rect(&self.config);
                return Task::batch([
                    window::gain_focus(id),
                    self.focus_input(),
                    Task::perform(
                        async move {
                            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                            tokio::task::spawn_blocking(move || {
                                windows::place("class:^command-space$", rect)
                            })
                            .await
                            .map_err(|e| e.to_string())?
                        },
                        Message::Result,
                    ),
                ]);
            }
            Message::Show(route, toggle) => return self.show(&route, toggle),
            Message::Hide => return self.hide(),
            Message::Query(query) => {
                let request = self.file_generation.fetch_add(1, Ordering::Relaxed) + 1;
                self.query = query;
                self.selected = 0;
                self.actions = false;
                self.rebuild();
                if let Some(callback) = self
                    .extension_view
                    .root()
                    .and_then(|root| root.callback("onSearchTextChange"))
                {
                    return self.update(Message::ExtensionInvoke(
                        callback,
                        vec![serde_json::json!(self.query)],
                    ));
                }
                if self.route == "files" {
                    let query = self.query.clone();
                    let roots = self.config.search_dirs.clone();
                    let generation = self.file_generation.clone();
                    let debounce = self.config.debounce_ms;
                    return Task::perform(
                        async move {
                            tokio::time::sleep(std::time::Duration::from_millis(debounce)).await;
                            if generation.load(Ordering::Relaxed) != request {
                                return (query, vec![]);
                            }
                            let copy = query.clone();
                            let files = tokio::task::spawn_blocking(move || {
                                desktop::files(&roots, &copy, || {
                                    generation.load(Ordering::Relaxed) == request
                                })
                            })
                            .await
                            .unwrap_or_default();
                            (query, files)
                        },
                        |(query, entries)| Message::Files(query, entries),
                    );
                }
            }
            Message::Move(delta) => {
                if !self.results.is_empty() {
                    self.selected = (self.selected as i32 + delta)
                        .rem_euclid(self.results.len() as i32)
                        as usize;
                    let columns = if self.route == "emoji" {
                        8
                    } else {
                        self.extension_view.grid_columns()
                    };
                    let offset = if self.extension_view.grid_columns() > 0 {
                        self.extension_view
                            .grid_offset(&self.results, self.selected)
                    } else if let Some(row) = self.selected.checked_div(columns) {
                        row.saturating_sub(1) as f32
                            * if self.route == "emoji" { 58.0 } else { 140.0 }
                    } else {
                        self.selected.saturating_sub(3) as f32 * 58.0
                    };
                    let selection = self
                        .extension_view
                        .selection_message(self.results.get(self.selected))
                        .map_or(Task::none(), |message| self.update(message));
                    return Task::batch([
                        selection,
                        widget::operation::scroll_to(
                            "results",
                            scrollable::AbsoluteOffset { x: 0.0, y: offset },
                        ),
                    ]);
                }
            }
            Message::Activate(index) => {
                self.selected = index;
                return self.activate();
            }
            Message::Submit => {
                return if self.actions {
                    self.update(Message::ActionChoice(self.action_selected))
                } else {
                    self.activate()
                };
            }
            Message::Back => {
                if let Some((id, _)) = self.oauth.take() {
                    if let Some(session) = self.extension.as_mut() {
                        let _ = session.send(serde_json::json!({"type":"response","id":id,"error":"Authorization canceled"}));
                    }
                    self.status = "Authorization canceled".into();
                    return Task::none();
                }
                if self.alert.is_some() {
                    return self.update(Message::AlertResponse(false));
                }
                if self.settings.is_some() {
                    return self.update(Message::CancelSettings);
                } else if self.actions {
                    self.actions = self.action_path.pop().is_some();
                    self.action_selected = 0;
                    self.action_query.clear();
                    return if self.actions {
                        widget::operation::focus("action-search")
                    } else {
                        self.focus_input()
                    };
                } else if self.extension.is_some() {
                    if let Some(session) = self.extension.as_mut() {
                        let _ = session.send(serde_json::json!({"type":"pop"}));
                    }
                } else if self.detail.is_some() {
                    self.detail = None;
                } else if !self.query.is_empty() {
                    self.query.clear();
                    self.selected = 0;
                    self.rebuild();
                } else if let Some((route, query, selected)) = self.stack.pop() {
                    self.route = route;
                    if self.route == "settings" {
                        self.settings = Some(super::settings::Editor::new(&self.config));
                    }
                    self.query = query;
                    self.selected = selected;
                    self.dynamic.clear();
                    self.rebuild();
                    return self.load_dynamic();
                } else {
                    return self.hide();
                }
                return widget::operation::focus("search");
            }
            Message::Dynamic(route, entries) => {
                if route == self.route {
                    self.dynamic = entries;
                    self.rebuild();
                }
            }
            Message::Files(query, entries) => {
                if self.route == "files" && self.query == query {
                    self.dynamic = entries;
                    self.rebuild();
                }
            }
            Message::Detail(title, body) => {
                self.detail = Some((title, widget::markdown::parse(&body).collect()));
            }
            Message::Result(result) => {
                if let Err(error) = &result
                    && self.window.is_none()
                {
                    let message = error.clone();
                    std::thread::spawn(move || {
                        let _ = Command::new("notify-send")
                            .args([
                                "--app-name=Command Space",
                                "Command could not finish",
                                &message,
                            ])
                            .status();
                    });
                }
                self.status = result.err().unwrap_or_default();
            }
            Message::Actions => {
                self.actions = !self.actions;
                self.action_selected = 0;
                self.action_path.clear();
                self.action_query.clear();
                return if self.actions {
                    widget::operation::focus("action-search")
                } else {
                    self.focus_input()
                };
            }
            Message::ActionQuery(query) => {
                self.action_query = query;
                self.action_selected = 0;
            }
            Message::ActionChoice(index) => {
                if let Some((_, message)) = self.panel_items().get(index).cloned() {
                    if !matches!(message, Message::ActionSubmenu(_)) {
                        self.actions = false;
                        self.action_path.clear();
                    }
                    return self.update(message);
                }
            }
            Message::ActionSubmenu(id) => {
                self.action_path.push(id.clone());
                self.action_selected = 0;
                self.action_query.clear();
                if let Some(callback) = self
                    .extension_view
                    .find(&id)
                    .and_then(|node| node.callback("onOpen"))
                {
                    return self.update(Message::ExtensionInvoke(callback, vec![]));
                }
            }
            Message::Favorite => {
                if let Some(entry) = self.results.get(self.selected) {
                    self.catalog.favorite(&entry.id);
                }
                self.actions = false;
                self.rebuild();
            }
            Message::CopyTitle => {
                if let Some(entry) = self.results.get(self.selected) {
                    return self.execute(Action::Copy(entry.title.clone()), false);
                }
            }
            Message::Run(action) => return self.run(action),
            Message::Quit => return iced::exit(),
            Message::Reload => {
                match Config::load() {
                    Ok(config) => self.config = config,
                    Err(error) => self.status = error,
                }
                self.colors = Colors::configured(&self.config);
                if !self.loading {
                    self.loading = true;
                    return Self::load();
                }
            }
            Message::Setting(key, value) => {
                if let Some(editor) = self.settings.as_mut() {
                    editor.change(&key, value);
                }
            }
            Message::CancelSettings => {
                self.settings = None;
                return self.update(Message::Back);
            }
            Message::SaveSettings => {
                if let Some(editor) = &self.settings {
                    match editor.validated().and_then(|config| {
                        config.save()?;
                        if super::integration::installed() {
                            super::integration::apply(&config)?;
                        }
                        Ok(config)
                    }) {
                        Ok(config) => {
                            self.config = config;
                            self.colors = Colors::configured(&self.config);
                            self.status = "Settings saved".into();
                            let rect = self.context.launcher_rect(&self.config);
                            if let Some(id) = self.window {
                                return Task::batch([
                                    window::resize(id, iced::Size::new(rect.width, rect.height)),
                                    Self::load(),
                                ]);
                            }
                        }
                        Err(error) => self.status = error,
                    }
                }
            }
            Message::AiKey(endpoint, remove) => {
                if url::Url::parse(&endpoint).ok().is_none_or(|url| {
                    !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
                }) {
                    self.status = "Enter a valid AI endpoint before setting its key".into();
                    return Task::none();
                }
                return Task::perform(
                    async move {
                        let mut command = tokio::process::Command::new("secret-tool");
                        if remove {
                            command.arg("clear");
                        } else {
                            let input = tokio::process::Command::new("zenity")
                                .args(["--password", "--title", "Command Space AI API key"])
                                .output()
                                .await
                                .map_err(|e| e.to_string())?;
                            if !input.status.success() {
                                return Ok(());
                            }
                            let key = String::from_utf8(input.stdout).map_err(|e| e.to_string())?;
                            command
                                .args(["store", "--label=Command Space AI provider"])
                                .args([
                                    "application",
                                    "command-space",
                                    "service",
                                    "ai",
                                    "endpoint",
                                    &endpoint,
                                ])
                                .stdin(std::process::Stdio::piped())
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::piped());
                            let mut child = command.spawn().map_err(|e| e.to_string())?;
                            use tokio::io::AsyncWriteExt;
                            if let Some(mut input) = child.stdin.take() {
                                input
                                    .write_all(key.trim_end_matches(['\r', '\n']).as_bytes())
                                    .await
                                    .map_err(|e| e.to_string())?;
                            }
                            let output =
                                child.wait_with_output().await.map_err(|e| e.to_string())?;
                            return if output.status.success() {
                                Ok(())
                            } else {
                                Err("Could not save the API key in the desktop keyring".into())
                            };
                        }
                        let status = command
                            .args([
                                "application",
                                "command-space",
                                "service",
                                "ai",
                                "endpoint",
                                &endpoint,
                            ])
                            .status()
                            .await
                            .map_err(|e| e.to_string())?;
                        if status.success() || status.code() == Some(1) {
                            Ok(())
                        } else {
                            Err("Could not remove the API key".into())
                        }
                    },
                    Message::Result,
                );
            }
            Message::Monitors(monitors) => {
                if let Some(id) = self.window
                    && let Some(monitors) = monitors.as_array()
                    && let Some(monitor) = monitors
                        .iter()
                        .find(|m| m["name"] == self.context.monitor["name"])
                        .or_else(|| monitors.iter().find(|m| m["focused"] == true))
                        .or_else(|| monitors.first())
                    && windows::monitor_rect(monitor, true)
                        != windows::monitor_rect(&self.context.monitor, true)
                {
                    self.context.monitor = monitor.clone();
                    let rect = self.context.launcher_rect(&self.config);
                    return Task::batch([
                        window::resize(id, iced::Size::new(rect.width, rect.height)),
                        Task::perform(
                            async move {
                                tokio::task::spawn_blocking(move || {
                                    windows::place("class:^command-space$", rect)
                                })
                                .await
                                .map_err(|e| e.to_string())?
                            },
                            Message::Result,
                        ),
                    ]);
                }
            }
            Message::Tick => {
                if self.config.check_updates && std::time::Instant::now() >= self.next_update_check
                {
                    self.next_update_check =
                        std::time::Instant::now() + std::time::Duration::from_secs(86400);
                    return Task::perform(super::updates::check(), |result| {
                        Message::UpdateChecked(false, result)
                    });
                }
                self.backgrounds.retain(|_, worker| {
                    let installed = super::extensions::root()
                        .join(&worker.session.extension)
                        .join("package.json")
                        .exists();
                    if !installed {
                        let _ = super::background::set_enabled(
                            &worker.session.extension,
                            &worker.session.command,
                            false,
                        );
                    }
                    installed
                });
                for worker in self.backgrounds.values_mut() {
                    worker.tick();
                }
                let stamp = std::fs::metadata(config_dir().join("config.toml"))
                    .and_then(|m| m.modified())
                    .ok();
                if stamp != self.config_stamp {
                    self.config_stamp = stamp;
                    if self.settings.is_none() {
                        return self.update(Message::Reload);
                    }
                }
                if self.route == "clipboard" && self.window.is_some() {
                    self.rebuild();
                }
                if self.window.is_some() {
                    return Task::perform(
                        async {
                            tokio::task::spawn_blocking(|| {
                                windows::query("monitors").unwrap_or_default()
                            })
                            .await
                            .unwrap_or_default()
                        },
                        Message::Monitors,
                    );
                }
            }
            Message::Key(key, modifiers, captured) => return self.key(key, modifiers, captured),
            Message::DeepLink(link) => match super::deeplink::parse(&link) {
                Ok(super::deeplink::Destination::OAuth(url)) => {
                    let state = url::Url::parse(&url).ok().and_then(|u| {
                        u.query_pairs()
                            .find(|(k, _)| k == "state")
                            .map(|(_, v)| v.into_owned())
                    });
                    if let Some(session) = self
                        .background_oauth
                        .iter()
                        .find(|(_, (_, expected))| Some(expected) == state.as_ref())
                        .map(|(id, _)| *id)
                        && let Some((request, _)) = self.background_oauth.remove(&session)
                    {
                        return self.update(Message::BackgroundResponse(
                            session,
                            request,
                            Ok(serde_json::json!(url)),
                        ));
                    }
                    if self
                        .oauth
                        .as_ref()
                        .is_some_and(|(_, expected)| Some(expected) == state.as_ref())
                    {
                        if let Some((id, _)) = self.oauth.take()
                            && let Some(session) = self.extension.as_mut()
                        {
                            let _ = session
                                .send(serde_json::json!({"type":"response","id":id,"value":url}));
                            self.status = "Completing authorization…".into();
                        }
                        return self.present();
                    } else {
                        self.status = "No matching authorization request is active".into();
                    }
                }
                Ok(super::deeplink::Destination::Route(route)) => return self.show(&route, false),
                Ok(super::deeplink::Destination::Search(query)) => {
                    let show = self.show("root", false);
                    let search = self.update(Message::Query(query));
                    return Task::batch([show, search]);
                }
                Ok(super::deeplink::Destination::Extension {
                    extension,
                    command,
                    arguments,
                }) => {
                    let show = self.show("root", false);
                    let launch = self.start_extension(&extension, &command, arguments);
                    return Task::batch([show, launch]);
                }
                Err(error) => self.status = error,
            },
            Message::EntryAction(action) => return self.entry_action(&action),
            Message::Url(url) => return self.execute(Action::Open(url), false),
            Message::Extension(id, event) => {
                if self.backgrounds.contains_key(&id) {
                    return self.background_event(id, event);
                }
                if self
                    .extension
                    .as_ref()
                    .is_none_or(|session| session.id != id)
                {
                    return Task::none();
                }
                match event["type"].as_str().unwrap_or("") {
                    "render" => match serde_json::from_value::<Vec<super::extensions::Node>>(
                        event["tree"].clone(),
                    ) {
                        Ok(nodes) => {
                            if self
                                .extension
                                .as_ref()
                                .is_some_and(|s| s.mode == "menu-bar")
                                && (nodes.is_empty()
                                    || super::background::menu_root(&nodes).is_some())
                            {
                                let session = self.extension.take().unwrap();
                                if let Err(error) = super::background::set_enabled(
                                    &session.extension,
                                    &session.command,
                                    true,
                                ) {
                                    self.status = error;
                                }
                                let worker = super::background::Worker::new(session);
                                worker.render(super::background::menu_root(&nodes));
                                self.backgrounds.insert(id, worker);
                                self.extension_view = Default::default();
                                return self.hide();
                            }
                            let previous_root =
                                self.extension_view.root().map(|node| node.id.clone());
                            self.extension_view
                                .update(nodes, event["inputRevision"].as_u64().unwrap_or(0));
                            let changed_root = previous_root
                                != self.extension_view.root().map(|node| node.id.clone());
                            if changed_root {
                                if let Some(id) = previous_root {
                                    self.extension_queries
                                        .insert(id, (self.query.clone(), self.selected));
                                }
                                let restored = self
                                    .extension_view
                                    .root()
                                    .and_then(|root| self.extension_queries.remove(&root.id))
                                    .unwrap_or_default();
                                self.query = restored.0;
                                self.selected = restored.1;
                                self.actions = false;
                            }
                            if let Some(value) = self
                                .extension_view
                                .root()
                                .and_then(|node| node.props["searchText"].as_str())
                            {
                                self.query = value.into();
                            }
                            self.rebuild();
                            if let Some(id) = self
                                .extension_view
                                .root()
                                .and_then(|node| node.props["selectedItemId"].as_str())
                                && let Some(index) = self.results.iter().position(|entry| {
                                    self.extension_view
                                        .find(entry.id.trim_start_matches("extension-item:"))
                                        .is_some_and(|node| node.text("id") == id)
                                })
                            {
                                self.selected = index;
                            }
                            if changed_root {
                                return self.focus_input();
                            }
                        }
                        Err(e) => self.status = format!("Extension UI: {e}"),
                    },
                    "error" => {
                        self.status = event["message"]
                            .as_str()
                            .unwrap_or("Extension failed")
                            .lines()
                            .next()
                            .unwrap_or_default()
                            .into()
                    }
                    "toast" => self.status = event["title"].as_str().unwrap_or_default().into(),
                    "metadata" => return Self::load(),
                    "close" => return self.hide(),
                    "launch-command" => return self.launch_command(&event),
                    "done" => {
                        if let Some(session) = self.extension.take() {
                            let worker = super::background::Worker::new(session);
                            if worker.scheduled() {
                                if let Err(error) = super::background::set_enabled(
                                    &worker.session.extension,
                                    &worker.session.command,
                                    true,
                                ) {
                                    self.status = error;
                                }
                                self.backgrounds.insert(id, worker);
                            }
                        }
                        self.extension = None;
                        self.extension_view = Default::default();
                        return self.hide();
                    }
                    "pop" => {
                        self.extension = None;
                        self.extension_view = Default::default();
                        self.query.clear();
                        self.rebuild();
                    }
                    "clear-search" => {
                        self.query.clear();
                        self.rebuild();
                    }
                    "field-command" => {
                        let id = event["id"].as_str().unwrap_or_default().to_string();
                        if event["operation"] == "focus" {
                            return self.update(Message::ExtensionFocus(id));
                        }
                        if event["operation"] == "reset" {
                            let value = event["value"].clone();
                            if let Some(text) = value.as_str()
                                && let Some(editor) = self.extension_view.editors.get_mut(&id)
                            {
                                *editor = widget::text_editor::Content::with_text(text);
                            }
                            let callback = self
                                .extension_view
                                .nodes
                                .iter()
                                .flat_map(super::extensions::Node::descendants)
                                .find(|n| n.text("id") == id)
                                .and_then(|n| n.callback("onChange"));
                            return self.update(Message::ExtensionField(id, value, callback));
                        }
                    }
                    "request" if event["kind"] == "confirm" => {
                        self.alert = Some((
                            event["id"].as_str().unwrap_or_default().into(),
                            event["options"].clone(),
                        ));
                    }
                    "cancel-request" => {
                        if self
                            .oauth
                            .as_ref()
                            .is_some_and(|(id, _)| Some(id.as_str()) == event["id"].as_str())
                        {
                            self.oauth = None;
                            return self.present();
                        }
                    }
                    "request" if event["kind"] == "oauth" => {
                        self.oauth = Some((
                            event["id"].as_str().unwrap_or_default().into(),
                            event["options"]["state"]
                                .as_str()
                                .unwrap_or_default()
                                .into(),
                        ));
                        self.status = format!(
                            "Waiting for {} authorization in your browser · Esc to cancel",
                            event["options"]["provider"].as_str().unwrap_or("provider")
                        );
                        return self.hide();
                    }
                    "request" => {
                        if let Some(session) = self.extension.as_mut() {
                            let _ = session.send(serde_json::json!({"type":"response","id":event["id"],"error":format!("Unsupported desktop request: {}", event["kind"])}));
                        }
                    }
                    "exited" => {
                        self.status = "Extension worker stopped".into();
                    }
                    _ => {}
                }
            }
            Message::ExtensionInvoke(callback, args) => {
                if let Some(session) = self.extension.as_mut()
                    && let Err(error) = session
                        .send(serde_json::json!({"type":"event","callback":callback,"args":args}))
                {
                    self.status = error;
                }
            }
            Message::BackgroundResponse(id, request, result) => {
                if let Some(worker) = self.backgrounds.get_mut(&id) {
                    let message = match result {
                        Ok(value) => {
                            serde_json::json!({"type":"response","id":request,"value":value})
                        }
                        Err(error) => {
                            serde_json::json!({"type":"response","id":request,"error":error})
                        }
                    };
                    if let Err(error) = worker.session.send(message) {
                        self.status = error;
                    }
                }
            }
            Message::ExtensionEdit(id, action, callback) => {
                if let Some(editor) = self.extension_view.editors.get_mut(&id) {
                    editor.perform(action);
                    let value = editor.text();
                    return self.update(Message::ExtensionField(
                        id,
                        serde_json::json!(value),
                        callback,
                    ));
                }
            }
            Message::ExtensionDate(id, props) => {
                let session_id = self.extension.as_ref().map_or(0, |s| s.id);
                let current = self
                    .extension_view
                    .fields
                    .get(&id)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                return Task::perform(
                    async move {
                        let mut command = tokio::process::Command::new("zenity");
                        command.args([
                            "--calendar",
                            "--title",
                            "Choose date",
                            "--date-format=%Y-%m-%d",
                        ]);
                        if current.len() >= 10 && current.is_ascii() {
                            for (flag, value) in [
                                ("--year", &current[0..4]),
                                ("--month", &current[5..7]),
                                ("--day", &current[8..10]),
                            ] {
                                if let Ok(number) = value.parse::<u32>() {
                                    command.args([flag, &number.to_string()]);
                                }
                            }
                        }
                        match command.output().await {
                            Ok(output) if output.status.success() => {
                                let date =
                                    String::from_utf8_lossy(&output.stdout).trim().to_string();
                                if props["min"]
                                    .as_str()
                                    .is_some_and(|min| date.as_str() < min.get(..10).unwrap_or(min))
                                    || props["max"].as_str().is_some_and(|max| {
                                        date.as_str() > max.get(..10).unwrap_or(max)
                                    })
                                {
                                    return Message::Result(Err(
                                        "Choose a date within the allowed range".into(),
                                    ));
                                }
                                Message::ExtensionPicked(
                                    session_id,
                                    id,
                                    serde_json::json!(format!(
                                        "{date}{}",
                                        current
                                            .get(10..)
                                            .filter(|s| !s.is_empty())
                                            .unwrap_or("T00:00:00.000Z")
                                    )),
                                    props["onChange"]["$callback"].as_str().map(String::from),
                                )
                            }
                            Ok(output) if output.status.code() == Some(1) => Message::Noop,
                            Ok(output) => Message::Result(Err(format!(
                                "Opening calendar: {}",
                                String::from_utf8_lossy(&output.stderr).trim()
                            ))),
                            Err(error) => {
                                Message::Result(Err(format!("Opening calendar: {error}")))
                            }
                        }
                    },
                    |message| message,
                );
            }
            Message::ExtensionPick(id, props) => {
                let session_id = self.extension.as_ref().map_or(0, |s| s.id);
                return Task::perform(
                    async move {
                        let mut command = tokio::process::Command::new("zenity");
                        command.args([
                            "--file-selection",
                            "--title",
                            "Choose files for Command Space",
                            "--separator",
                            "\n",
                        ]);
                        if props["allowMultipleSelection"] == true {
                            command.arg("--multiple");
                        }
                        if props["canChooseDirectories"] == true && props["canChooseFiles"] != true
                        {
                            command.arg("--directory");
                        }
                        match command.output().await {
                            Ok(output) if output.status.success() => Message::ExtensionPicked(
                                session_id,
                                id,
                                serde_json::json!(
                                    String::from_utf8_lossy(&output.stdout)
                                        .trim_end()
                                        .lines()
                                        .collect::<Vec<_>>()
                                ),
                                props["onChange"]["$callback"].as_str().map(String::from),
                            ),
                            Ok(_) => Message::Noop,
                            Err(error) => {
                                Message::Result(Err(format!("Opening file picker: {error}")))
                            }
                        }
                    },
                    |message| message,
                );
            }
            Message::ExtensionPicked(session, id, value, callback) => {
                if self.extension.as_ref().is_some_and(|s| s.id == session) {
                    return self.update(Message::ExtensionField(id, value, callback));
                }
            }
            Message::ExtensionInstalled(result) => {
                self.installing = false;
                self.status = match result {
                    Ok(name) if name.is_empty() => String::new(),
                    Ok(name) => format!("Installed {name}"),
                    Err(error) => error,
                };
                self.loading = true;
                return Self::load();
            }
            Message::ExtensionField(id, value, callback) => {
                let revision = self.extension_view.edit_field(&id, value.clone());
                if let Some(callback) = callback
                    && let Some(session) = self.extension.as_mut()
                    && let Err(error) = session.send(serde_json::json!({"type":"event","callback":callback,"args":[value],"field":id,"inputRevision":revision})) { self.status = error; }
            }
            Message::ExtensionFocus(id) => return self.focus_extension_field(id),
            Message::AlertResponse(value) => {
                if let Some((id, _)) = self.alert.take() {
                    if let Some(operation) = id.strip_prefix("native:") {
                        if value {
                            return self.confirmed(operation);
                        }
                    } else if let Some(session) = self.extension.as_mut()
                        && let Err(error) = session
                            .send(serde_json::json!({"type":"response","id":id,"value":value}))
                    {
                        self.status = error;
                    }
                }
            }
            Message::Noop => {}
        }
        Task::none()
    }

    fn activate(&mut self) -> Task<Message> {
        if self.alert.is_some() {
            return self.update(Message::AlertResponse(true));
        }
        if self.extension.is_some() {
            let selected = self
                .results
                .get(self.selected)
                .map(|entry| entry.id.as_str());
            let action = self
                .extension_view
                .panel_nodes(selected, None)
                .into_iter()
                .find(|node| node.kind == "Action" || node.kind == "Action.SubmitForm")
                .map(|a| self.extension_view.action_message(a));
            return action.map_or(Task::none(), |message| self.update(message));
        }
        let Some(entry) = self.results.get(self.selected).cloned() else {
            return Task::none();
        };
        self.catalog.record(&entry.id);
        self.run(entry.action)
    }

    fn run(&mut self, action: Action) -> Task<Message> {
        match action {
            Action::Extension { extension, command } => {
                self.start_extension(&extension, &command, serde_json::Value::Null)
            }
            Action::Menu(route) => self.enter(route),
            Action::Builtin(name) => match name.as_str() {
                _ if name.starts_with("extension-stop:") => {
                    if let Some((extension, command)) =
                        name.trim_start_matches("extension-stop:").split_once('/')
                    {
                        self.status = super::background::set_enabled(extension, command, false)
                            .err()
                            .unwrap_or_default();
                        self.backgrounds.retain(|_, w| {
                            w.session.extension != extension || w.session.command != command
                        });
                        self.rebuild();
                    }
                    Task::none()
                }
                "refresh" => self.update(Message::Reload),
                "updates" => {
                    self.settings = None;
                    self.extension = None;
                    self.status = "Checking for updates…".into();
                    self.enter("updates".into())
                }
                "install-update" => {
                    if let Some(release) = &self.release
                        && release.available
                    {
                        self.status = "Starting update…".into();
                        Task::perform(
                            super::updates::install(release.version.clone()),
                            Message::UpdateStarted,
                        )
                    } else {
                        Task::none()
                    }
                }
                "quit" => iced::exit(),
                "quit-all" => {
                    self.confirm("quit-all", "Quit all applications?", "Each application will receive a close request. Apps can still ask you to save unsaved work.");
                    Task::none()
                }
                _ if matches!(name.as_str(), "extension-install" | "extension-download")
                    || name.starts_with("extension-replace:") =>
                {
                    if self.installing {
                        return Task::none();
                    }
                    self.installing = true;
                    self.status = "Installing extension… Choose its source to continue.".into();
                    let download = name == "extension-download";
                    let replacement = name.strip_prefix("extension-replace:").map(String::from);
                    Task::perform(
                        async move {
                            let mut picker = tokio::process::Command::new("zenity");
                            if download {
                                picker.args([
                                    "--entry",
                                    "--title=Install Extension",
                                    "--text=GitHub repository or extension folder URL",
                                ]);
                            } else {
                                picker.args([
                                    "--file-selection",
                                    "--directory",
                                    "--title=Choose Extension Source Folder",
                                ]);
                            }
                            let output = picker.output().await.map_err(|e| e.to_string())?;
                            if !output.status.success() {
                                return Ok(String::new());
                            }
                            let location =
                                String::from_utf8_lossy(&output.stdout).trim().to_string();
                            tokio::task::spawn_blocking(move || {
                                if let Some(name) = &replacement
                                    && super::extensions::manifest(std::path::Path::new(&location))?
                                        .name
                                        != *name
                                {
                                    return Err(format!("Choose a source folder for {name}"));
                                }
                                super::extensions::install_location(
                                    &location,
                                    replacement.is_some(),
                                )
                            })
                            .await
                            .map_err(|e| e.to_string())?
                        },
                        Message::ExtensionInstalled,
                    )
                }
                _ if name.starts_with("extension-update:") => {
                    if self.installing {
                        return Task::none();
                    }
                    self.installing = true;
                    self.extension = None;
                    self.status = "Updating extension…".into();
                    let name = name.trim_start_matches("extension-update:").to_string();
                    Task::perform(
                        async move {
                            tokio::task::spawn_blocking(move || super::extensions::update(&name))
                                .await
                                .map_err(|e| e.to_string())?
                        },
                        Message::ExtensionInstalled,
                    )
                }
                _ if name.starts_with("extension-remove:") => {
                    let extension = name.trim_start_matches("extension-remove:");
                    self.confirm(
                        &name,
                        &format!("Uninstall {extension}?"),
                        "Its commands will be removed. Preferences and stored data are kept.",
                    );
                    Task::none()
                }
                "edit-config" => self.execute(
                    Action::Shell(format!(
                        "omarchy-launch-config-editor {}",
                        shell_quote(&config_dir().join("config.toml").to_string_lossy())
                    )),
                    true,
                ),
                "clipboard-paste" => {
                    self.config.clipboard_paste_on_select = !self.config.clipboard_paste_on_select;
                    self.status = self.config.save().err().unwrap_or_default();
                    self.rebuild();
                    Task::none()
                }
                _ if name.starts_with("package:") => {
                    let name = name.trim_start_matches("package:").to_string();
                    Task::perform(
                        async move {
                            let output = tokio::process::Command::new("pacman")
                                .args(["-Qi", &name])
                                .output()
                                .await;
                            let body = output
                                .map(|o| {
                                    format!("```text\n{}\n```", String::from_utf8_lossy(&o.stdout))
                                })
                                .unwrap_or_else(|e| e.to_string());
                            (name, body)
                        },
                        |(title, body)| Message::Detail(title, body),
                    )
                }
                _ if name.starts_with("mode:") => {
                    let task = self.enter(name.clone());
                    let command = self
                        .config
                        .modes
                        .get(name.trim_start_matches("mode:"))
                        .cloned()
                        .unwrap_or_default();
                    Task::batch([
                        task,
                        Task::perform(
                            async move {
                                let entries = tokio::process::Command::new("bash")
                                    .args(["-lc", &command])
                                    .output()
                                    .await
                                    .ok()
                                    .map(|o| {
                                        String::from_utf8_lossy(&o.stdout)
                                            .lines()
                                            .enumerate()
                                            .map(|(i, line)| {
                                                let (title, command) =
                                                    line.split_once('\t').unwrap_or((line, line));
                                                Entry::new(
                                                    &format!("mode-item:{i}"),
                                                    title,
                                                    "Custom command",
                                                    "",
                                                    Action::Shell(command.into()),
                                                )
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                (name, entries)
                            },
                            |(name, entries)| Message::Dynamic(name, entries),
                        ),
                    ])
                }
                _ => self.enter(name),
            },
            action => self.execute(action, true),
        }
    }

    fn background_event(&mut self, id: u64, event: serde_json::Value) -> Task<Message> {
        use serde_json::json;
        let kind = event["type"].as_str().unwrap_or_default();
        match kind {
            "metadata" => return Self::load(),
            "render" => {
                if let Ok(nodes) =
                    serde_json::from_value::<Vec<super::extensions::Node>>(event["tree"].clone())
                {
                    let root = super::background::menu_root(&nodes);
                    let has_view = nodes
                        .iter()
                        .flat_map(super::extensions::Node::descendants)
                        .any(|node| {
                            matches!(node.kind.as_str(), "Form" | "List" | "Grid" | "Detail")
                        });
                    if root.is_none() && has_view {
                        let worker = self.backgrounds.remove(&id).unwrap();
                        self.extension = Some(worker.session);
                        self.extension_view = Default::default();
                        self.extension_queries.clear();
                        self.query.clear();
                        self.context = windows::Context::capture(self.config.follow_mouse);
                        let present = self.present();
                        let render = self.update(Message::Extension(id, event));
                        return Task::batch([present, render]);
                    }
                    if let Some(worker) = self.backgrounds.get(&id) {
                        worker.render(root);
                    }
                }
            }
            "tray-action" | "tray-preferences" => {
                if let Some(worker) = self.backgrounds.get_mut(&id) {
                    let message = if kind == "tray-action" {
                        json!({"type":"event","callback":event["callback"],"args":[{"type":"left-click"}]})
                    } else {
                        json!({"type":"preferences"})
                    };
                    if let Err(error) = worker.session.send(message) {
                        self.status = error;
                    }
                }
            }
            "tray-refresh" => {
                if let Some(worker) = self.backgrounds.get_mut(&id)
                    && let Err(error) = worker.refresh(false)
                {
                    self.status = error;
                }
            }
            "tray-stop" => {
                if let Some(worker) = self.backgrounds.remove(&id)
                    && let Err(error) = super::background::set_enabled(
                        &worker.session.extension,
                        &worker.session.command,
                        false,
                    )
                {
                    self.status = error;
                }
                self.background_oauth.remove(&id);
            }
            "request" if event["kind"] == "confirm" => {
                let request = event["id"].as_str().unwrap_or_default().to_owned();
                let options = event["options"].clone();
                return Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            let text = [
                                options["title"].as_str().unwrap_or("Continue?"),
                                options["message"].as_str().unwrap_or_default(),
                            ]
                            .join("\n\n");
                            let status = Command::new("zenity")
                                .args([
                                    "--question",
                                    "--no-markup",
                                    "--title=Command Space",
                                    "--text",
                                    &text,
                                    "--ok-label",
                                    options["primaryAction"]["title"]
                                        .as_str()
                                        .unwrap_or("Continue"),
                                    "--cancel-label",
                                    options["dismissAction"]["title"]
                                        .as_str()
                                        .unwrap_or("Cancel"),
                                ])
                                .status()
                                .map_err(|e| e.to_string())?;
                            Ok(json!(status.success()))
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    move |result| Message::BackgroundResponse(id, request.clone(), result),
                );
            }
            "request" if event["kind"] == "oauth" => {
                self.background_oauth.insert(
                    id,
                    (
                        event["id"].as_str().unwrap_or_default().into(),
                        event["options"]["state"]
                            .as_str()
                            .unwrap_or_default()
                            .into(),
                    ),
                );
            }
            "request" => {
                return self.update(Message::BackgroundResponse(
                    id,
                    event["id"].as_str().unwrap_or_default().into(),
                    Err(format!("Unsupported desktop request: {}", event["kind"])),
                ));
            }
            "cancel-request" => {
                self.background_oauth.remove(&id);
            }
            "launch-command" => return self.launch_command(&event),
            "done" => {
                if self.backgrounds.get(&id).is_none_or(|w| !w.scheduled()) {
                    self.backgrounds.remove(&id);
                }
                self.background_oauth.remove(&id);
            }
            "exited" => {
                self.backgrounds.remove(&id);
                self.background_oauth.remove(&id);
            }
            "toast" | "error" => {
                let title = event["title"]
                    .as_str()
                    .or(event["message"].as_str())
                    .unwrap_or_default();
                if !title.is_empty() {
                    let title = title.lines().next().unwrap_or_default().to_owned();
                    self.status = title.clone();
                    return Task::perform(
                        async move {
                            let _ = tokio::process::Command::new("notify-send")
                                .args(["--app-name=Command Space", "--", &title])
                                .status()
                                .await;
                        },
                        |_| Message::Noop,
                    );
                }
            }
            _ => {}
        }
        Task::none()
    }

    fn launch_command(&mut self, event: &serde_json::Value) -> Task<Message> {
        let extension = event["extensionName"].as_str().unwrap_or_default();
        let command = event["name"].as_str().unwrap_or_default();
        let arguments = event.get("arguments").cloned().unwrap_or_default();
        let context = event.get("launchContext").cloned().unwrap_or_default();
        let background = event["launchType"] == "background";
        if let Some(worker) = self
            .backgrounds
            .values_mut()
            .find(|w| w.session.extension == extension && w.session.command == command)
        {
            if let Err(error) = worker.launch(background, arguments, context) {
                self.status = error;
            }
            return Task::none();
        }
        match super::extensions::Session::start_with_options(
            extension,
            command,
            arguments,
            context,
            &self.context,
            background,
        ) {
            Ok(session) if background => {
                self.backgrounds
                    .insert(session.id, super::background::Worker::new(session));
                Task::none()
            }
            Ok(session) => {
                let show = self.show("root", false);
                self.set_extension(session);
                show
            }
            Err(error) => {
                self.status = error;
                Task::none()
            }
        }
    }

    fn set_extension(&mut self, session: super::extensions::Session) {
        self.extension = Some(session);
        self.extension_view = Default::default();
        self.extension_queries.clear();
        self.query.clear();
        self.status.clear();
        self.results.clear();
        self.selected = 0;
    }

    fn start_extension(
        &mut self,
        extension: &str,
        command: &str,
        arguments: serde_json::Value,
    ) -> Task<Message> {
        if let Some(worker) = self
            .backgrounds
            .values_mut()
            .find(|w| w.session.extension == extension && w.session.command == command)
        {
            if let Err(error) = worker.refresh(false) {
                self.status = error;
            }
            return self.hide();
        }
        match super::extensions::Session::start(extension, command, arguments, &self.context) {
            Ok(session) => {
                self.set_extension(session);
            }
            Err(error) => self.status = error,
        }
        Task::none()
    }

    fn execute(&mut self, action: Action, hide: bool) -> Task<Message> {
        let action = if let Action::Window { operation, target } = action {
            Action::Window {
                operation,
                target: if target.is_empty() {
                    self.context
                        .previous
                        .as_ref()
                        .map(|c| c.id.clone())
                        .unwrap_or_default()
                } else {
                    target
                },
            }
        } else {
            action
        };
        let paste = hide && self.route == "clipboard" && self.config.clipboard_paste_on_select;
        if hide && self.config.clear_on_enter {
            self.query.clear();
        }
        let hide = if hide { self.hide() } else { Task::none() };
        Task::batch([
            hide,
            Task::perform(
                async move {
                    tokio::task::spawn_blocking(move || execute_action(action, paste))
                        .await
                        .map_err(|e| e.to_string())?
                },
                Message::Result,
            ),
        ])
    }

    fn confirm(&mut self, operation: &str, title: &str, message: &str) {
        self.alert = Some((
            format!("native:{operation}"),
            serde_json::json!({"title":title,"message":message,"primaryAction":{"title":"Continue"},"dismissAction":{"title":"Cancel"}}),
        ));
        self.actions = false;
    }

    fn confirmed(&mut self, operation: &str) -> Task<Message> {
        if let Some(name) = operation.strip_prefix("extension-remove:") {
            self.extension = None;
            self.backgrounds.retain(|_, worker| {
                if worker.session.extension != name {
                    return true;
                }
                let _ = super::background::set_enabled(name, &worker.session.command, false);
                false
            });
            match super::extensions::remove(name) {
                Ok(()) => {
                    self.status = format!("Uninstalled {name}");
                    self.route = "extensions".into();
                    self.dynamic.clear();
                    self.loading = true;
                    return Self::load();
                }
                Err(error) => self.status = error,
            }
        } else if operation == "clear-clipboard" {
            self.status = catalog::remove_clipboard(None).err().unwrap_or_default();
            self.rebuild();
        } else if operation == "quit-all" {
            return Task::batch([
                self.hide(),
                Task::perform(
                    async {
                        tokio::task::spawn_blocking(|| {
                            for client in windows::clients() {
                                windows::operate("close", &client.id)?;
                            }
                            Ok(())
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    Message::Result,
                ),
            ]);
        } else if let Some(path) = operation.strip_prefix("trash:") {
            return self.execute(
                Action::Shell(format!("gio trash -- {}", shell_quote(path))),
                true,
            );
        }
        Task::none()
    }

    fn entry_action(&mut self, operation: &str) -> Task<Message> {
        self.actions = false;
        if operation == "clear-clipboard" {
            self.confirm(
                "clear-clipboard",
                "Clear clipboard history?",
                "All saved clipboard items will be removed.",
            );
            return Task::none();
        }
        let Some(entry) = self.results.get(self.selected).cloned() else {
            return Task::none();
        };
        match operation {
            "copy" => {
                let action = match entry.action {
                    Action::Copy(_) | Action::CopyImage(_) => entry.action,
                    Action::Open(path) | Action::Desktop(path) => Action::Copy(path),
                    _ => Action::Copy(entry.title),
                };
                return self.execute(action, false);
            }
            "paste" => {
                let action = entry.action;
                return Task::batch([
                    self.hide(),
                    Task::perform(
                        async move {
                            tokio::task::spawn_blocking(move || execute_action(action, true))
                                .await
                                .map_err(|e| e.to_string())?
                        },
                        Message::Result,
                    ),
                ]);
            }
            "delete" if self.route == "clipboard" => {
                self.status = catalog::remove_clipboard(Some(&entry.id))
                    .err()
                    .unwrap_or_default();
                self.rebuild();
            }
            "reveal" => {
                if let Action::Open(path) | Action::Desktop(path) = entry.action {
                    let parent = std::path::Path::new(&path)
                        .parent()
                        .unwrap_or(std::path::Path::new("/"));
                    return self.execute(Action::Open(parent.to_string_lossy().into()), true);
                }
            }
            "delete" => {
                if let Action::Open(path) = entry.action {
                    self.confirm(&format!("trash:{path}"), "Move this file to Trash?", &path);
                }
            }
            "preview" => {
                if let Action::Open(path) = entry.action {
                    return Task::perform(
                        async move {
                            use tokio::io::AsyncReadExt;
                            let bytes = async {
                                let file = tokio::fs::File::open(&path).await?;
                                let mut bytes = Vec::new();
                                file.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
                                Ok::<_, std::io::Error>(bytes)
                            }
                            .await;
                            let display = match bytes {
                                Ok(bytes) if bytes.len() <= 1024 * 1024 => String::from_utf8(bytes)
                                    .unwrap_or_else(|_| {
                                        "Binary file · use Open to view it in its application"
                                            .into()
                                    }),
                                Ok(_) => "File is larger than the 1 MB text preview limit".into(),
                                Err(e) => e.to_string(),
                            };
                            (
                                path,
                                format!("````text\n{}\n````", display.replace("````", "` ` ` `")),
                            )
                        },
                        |(title, body)| Message::Detail(title, body),
                    );
                }
            }
            _ => {}
        }
        Task::none()
    }

    fn focus_extension_field(&mut self, id: String) -> Task<Message> {
        let fields = self.extension_view.form_fields();
        if !fields.iter().any(|node| node.text("id") == id) {
            return Task::none();
        }
        if self.extension_view.focused != id {
            let mut events = Vec::new();
            for (field, event_type, callback) in [
                (&self.extension_view.focused, "blur", "onBlur"),
                (&id, "focus", "onFocus"),
            ] {
                if let Some(node) = fields.iter().find(|node| node.text("id") == field)
                    && let Some(callback) = node.callback(callback)
                {
                    let value = self
                        .extension_view
                        .fields
                        .get(field)
                        .cloned()
                        .unwrap_or_default();
                    events.push(serde_json::json!({"type":"event","callback":callback,"args":[{"type":event_type,"target":{"id":field,"value":value}}]}));
                }
            }
            self.extension_view.focused = id.clone();
            for event in events {
                if let Some(session) = self.extension.as_mut()
                    && let Err(error) = session.send(event)
                {
                    self.status = error;
                }
            }
        }
        widget::operation::focus(widget::Id::from(format!("field:{id}")))
            .chain(super::form_field::reveal(id))
    }

    fn form_key(&mut self, key: &Key) -> Option<Message> {
        let node = self
            .extension_view
            .form_fields()
            .into_iter()
            .find(|node| node.text("id") == self.extension_view.focused)?;
        let id = node.text("id").to_string();
        let callback = node.callback("onChange");
        let value = self
            .extension_view
            .fields
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let space = key == &Key::Named(Named::Space) || key == &Key::Character(" ".into());
        let delta = match key {
            Key::Named(Named::ArrowDown) => 1,
            Key::Named(Named::ArrowUp) => -1,
            _ => 0,
        };
        match node.kind.as_str() {
            "Form.Checkbox" if space => Some(Message::ExtensionField(
                id,
                serde_json::json!(!value.as_bool().unwrap_or(false)),
                callback,
            )),
            "Form.FilePicker" if space => Some(Message::ExtensionPick(id, node.props.clone())),
            "Form.Dropdown" if delta != 0 => {
                let items: Vec<_> = node
                    .descendants()
                    .into_iter()
                    .filter(|node| node.kind == "Form.Dropdown.Item")
                    .map(|node| node.text("value").to_string())
                    .collect();
                if items.is_empty() {
                    return None;
                }
                let current = items
                    .iter()
                    .position(|item| Some(item.as_str()) == value.as_str())
                    .unwrap_or(0);
                let next = (current as i32 + delta).rem_euclid(items.len() as i32) as usize;
                Some(Message::ExtensionField(
                    id,
                    serde_json::json!(items[next]),
                    callback,
                ))
            }
            "Form.TagPicker" if delta != 0 || space => {
                let items: Vec<_> = node
                    .descendants()
                    .into_iter()
                    .filter(|node| node.kind == "Form.TagPicker.Item")
                    .map(|node| node.text("value").to_string())
                    .collect();
                if items.is_empty() {
                    return None;
                }
                let current = self
                    .extension_view
                    .tag_selection
                    .get(&id)
                    .copied()
                    .unwrap_or(0);
                let next = (current as i32 + delta).rem_euclid(items.len() as i32) as usize;
                self.extension_view.tag_selection.insert(id.clone(), next);
                if space {
                    let mut selected = value.as_array().cloned().unwrap_or_default();
                    let item = serde_json::json!(items[next]);
                    if selected.contains(&item) {
                        selected.retain(|value| value != &item);
                    } else {
                        selected.push(item);
                    }
                    Some(Message::ExtensionField(
                        id,
                        serde_json::json!(selected),
                        callback,
                    ))
                } else {
                    Some(Message::Noop)
                }
            }
            _ => None,
        }
    }

    fn key(&mut self, key: Key, modifiers: keyboard::Modifiers, captured: bool) -> Task<Message> {
        if key == Key::Named(Named::Escape) {
            return self.update(Message::Back);
        }
        if self.alert.is_some() {
            return if key == Key::Named(Named::Enter) {
                self.update(Message::AlertResponse(true))
            } else {
                Task::none()
            };
        }
        if self.actions {
            let count = self.panel_items().len();
            let delta = match key.as_ref() {
                Key::Named(Named::ArrowDown) => 1,
                Key::Named(Named::ArrowUp) => -1,
                Key::Character("n") if modifiers.control() => 1,
                Key::Character("p") if modifiers.control() => -1,
                _ => 0,
            };
            if count > 0 && delta != 0 {
                self.action_selected =
                    (self.action_selected as i32 + delta).rem_euclid(count as i32) as usize;
                return widget::operation::scroll_to(
                    "action-choices",
                    scrollable::AbsoluteOffset {
                        x: 0.0,
                        y: self.action_selected.saturating_sub(3) as f32 * 40.0,
                    },
                );
            }
            if key == Key::Named(Named::Enter) {
                return self.update(Message::ActionChoice(self.action_selected));
            }
            if key == Key::Character("k".into()) && modifiers.control() {
                return self.update(Message::Actions);
            }
            return Task::none();
        }
        if self.settings.is_some() {
            if key == Key::Named(Named::Tab) {
                return if modifiers.shift() {
                    widget::operation::focus_previous()
                } else {
                    widget::operation::focus_next()
                };
            }
            return Task::none();
        }
        if self.extension.is_some() {
            let selected = self.results.get(self.selected).map(|e| e.id.as_str());
            if let Some(action) = self.extension_view.shortcut(selected, &key, modifiers) {
                return self.update(self.extension_view.action_message(action));
            }
        }
        let is_form = self.extension_view.root().is_some_and(|n| n.kind == "Form");
        if is_form && key == Key::Named(Named::Tab) {
            return self
                .extension_view
                .next_field(modifiers.shift())
                .map_or(Task::none(), |id| self.focus_extension_field(id));
        }
        if is_form && !captured && !modifiers.control() && !modifiers.alt() {
            if let Some(message) = self.form_key(&key) {
                return self.update(message);
            }
            if key == Key::Named(Named::Enter) {
                return self.update(Message::Submit);
            }
        }
        let columns = if self.route == "emoji" {
            8
        } else {
            self.extension_view.grid_columns() as i32
        };
        if self.extension_view.grid_columns() > 0 {
            let delta = match key {
                Key::Named(Named::ArrowDown) => 1,
                Key::Named(Named::ArrowUp) => -1,
                Key::Named(Named::PageDown) => 5,
                Key::Named(Named::PageUp) => -5,
                _ => 0,
            };
            if delta != 0 {
                let next = self
                    .extension_view
                    .grid_move(&self.results, self.selected, delta);
                return self.update(Message::Move(next as i32 - self.selected as i32));
            }
        }
        let message = match key.as_ref() {
            Key::Character("k") if modifiers.control() => Some(Message::Actions),
            Key::Character("f")
                if modifiers.control() && modifiers.shift() && self.extension.is_none() =>
            {
                Some(Message::Favorite)
            }
            _ if is_form => None,
            Key::Named(Named::ArrowDown) => Some(Message::Move(columns.max(1))),
            Key::Named(Named::ArrowUp) => Some(Message::Move(-columns.max(1))),
            Key::Named(Named::ArrowLeft) if columns > 0 => Some(Message::Move(-1)),
            Key::Named(Named::ArrowRight) if columns > 0 => Some(Message::Move(1)),
            Key::Named(Named::PageDown) => Some(Message::Move(columns.max(1) * 5)),
            Key::Named(Named::PageUp) => Some(Message::Move(-columns.max(1) * 5)),
            Key::Character("n") if modifiers.control() => Some(Message::Move(1)),
            Key::Character("p") if modifiers.control() => Some(Message::Move(-1)),
            Key::Named(Named::Delete) if self.route == "clipboard" => Some(Message::EntryAction(
                if modifiers.shift() {
                    "clear-clipboard"
                } else {
                    "delete"
                }
                .into(),
            )),
            _ => None,
        };
        message.map_or(Task::none(), |m| self.update(m))
    }

    pub fn theme(&self, _id: window::Id) -> iced::Theme {
        self.colors.theme()
    }

    pub fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            super::ipc::subscription(),
            super::extensions::subscription(),
            iced::time::every(std::time::Duration::from_secs(2)).map(|_| Message::Tick),
            window::close_requests().map(|_| Message::Hide),
            iced::event::listen_with(|event, status, _id| {
                if let iced::Event::Keyboard(keyboard::Event::KeyPressed {
                    key, modifiers, ..
                }) = event
                {
                    if key == Key::Named(Named::Enter) && status == iced::event::Status::Captured {
                        return None;
                    }
                    Some(Message::Key(
                        key,
                        modifiers,
                        status == iced::event::Status::Captured,
                    ))
                } else {
                    None
                }
            }),
        ])
    }

    pub fn view(&self, _id: window::Id) -> Element<'_, Message> {
        let colors = self.colors;
        let mut header = row![
            button(text("‹").size(25))
                .style(move |_, s| colors.row(false, s))
                .on_press(Message::Back),
            text("COMMAND SPACE").size(12).color(colors.accent),
            widget::Space::new().width(Fill)
        ];
        if self.route != "root" {
            header = header.push(
                text(self.catalog.menu.title(&self.route))
                    .size(12)
                    .color(colors.muted),
            );
        }
        let placeholder = self
            .extension_view
            .root()
            .map(|r| r.text("searchBarPlaceholder"))
            .filter(|p| !p.is_empty())
            .unwrap_or(&self.config.placeholder);
        let search = text_input(placeholder, &self.query)
            .id("search")
            .on_input(Message::Query)
            .on_submit(Message::Submit)
            .size(22)
            .padding([14, 18])
            .style(move |_, _| colors.input());
        let content: Element<'_, Message> = if let Some((_, options)) = &self.alert {
            container(
                column![
                    text(options["title"].as_str().unwrap_or("Confirm")).size(22),
                    text(options["message"].as_str().unwrap_or("")).size(14),
                    row![
                        button(text(
                            options["dismissAction"]["title"]
                                .as_str()
                                .unwrap_or("Cancel")
                        ))
                        .on_press(Message::AlertResponse(false)),
                        button(text(
                            options["primaryAction"]["title"]
                                .as_str()
                                .unwrap_or("Continue")
                        ))
                        .on_press(Message::AlertResponse(true))
                    ]
                    .spacing(12)
                ]
                .spacing(20)
                .padding(24),
            )
            .center(Fill)
            .into()
        } else if let Some(editor) = &self.settings {
            editor.view(colors)
        } else if self.route == "lemon" {
            container(
                widget::image(widget::image::Handle::from_bytes(
                    include_bytes!("../../assets/macos/RustCast.app/Contents/Resources/lemon.png")
                        .as_slice(),
                ))
                .height(220),
            )
            .center(Fill)
            .into()
        } else if let Some(content) =
            self.extension_view
                .content(colors, &self.results, self.selected)
        {
            content
        } else if let Some((title, markdown)) = &self.detail {
            scrollable(
                column![
                    text(title).size(21),
                    widget::markdown::view(
                        markdown,
                        widget::markdown::Settings::with_style(
                            widget::markdown::Style::from_palette(self.colors.theme().palette())
                        )
                    )
                    .map(Message::Url)
                ]
                .spacing(14)
                .padding(18),
            )
            .height(Fill)
            .into()
        } else if self.route == "emoji" && !self.results.is_empty() {
            let mut grid = column![].spacing(6).padding(10);
            for (chunk_index, chunk) in self.results.chunks(8).enumerate() {
                let mut cells = row![].spacing(6);
                for (column_index, entry) in chunk.iter().enumerate() {
                    let index = chunk_index * 8 + column_index;
                    let selected = index == self.selected;
                    cells = cells.push(widget::tooltip(
                        button(container(text(&entry.title).size(30)).center(Fill))
                            .width(Fill)
                            .height(52)
                            .style(move |_, s| colors.row(selected, s))
                            .on_press(Message::Activate(index)),
                        text(&entry.subtitle),
                        widget::tooltip::Position::Bottom,
                    ));
                }
                for _ in chunk.len()..8 {
                    cells = cells.push(widget::Space::new().width(Fill));
                }
                grid = grid.push(cells);
            }
            scrollable(grid).id("results").height(Fill).into()
        } else if self.results.is_empty() {
            container(
                column![
                    text(if self.loading {
                        "Loading commands…"
                    } else if self.route == "files" && self.query.len() < 2 {
                        "Type at least two characters to find files"
                    } else {
                        "No results"
                    })
                    .size(18),
                    text(if self.route == "extensions" {
                        "Install an extension with command-space extension install <path>"
                    } else {
                        "Search by name, or press Esc to go back"
                    })
                    .size(12)
                    .color(colors.muted)
                ]
                .spacing(10),
            )
            .center(Fill)
            .into()
        } else {
            let mut list = column![].spacing(2);
            let mut section_id = String::new();
            for (index, entry) in self.results.iter().enumerate() {
                if let Some(section) = self.extension_view.section(entry)
                    && section.id != section_id
                {
                    section_id = section.id.clone();
                    list = list.push(
                        container(text(section.text("title")).size(12).color(colors.muted))
                            .padding([6, 14]),
                    );
                }
                let selected = self.selected == index;
                let favorite = self.catalog.ranks.get(&entry.id).is_some_and(|(_, f)| *f);
                let icon: Element<'_, Message> = if !self.config.show_icons {
                    widget::Space::new().width(0).into()
                } else if let Some(node) = self
                    .extension_view
                    .find(entry.id.trim_start_matches("extension-item:"))
                {
                    super::extension_image::view(
                        &node.props["icon"],
                        28.,
                        28.,
                        iced::ContentFit::Contain,
                        colors,
                    )
                } else if entry.icon.starts_with('/') && std::path::Path::new(&entry.icon).is_file()
                {
                    if entry.icon.ends_with(".svg") {
                        widget::svg(widget::svg::Handle::from_path(&entry.icon))
                            .width(28)
                            .height(28)
                            .into()
                    } else {
                        widget::image(widget::image::Handle::from_path(&entry.icon))
                            .width(28)
                            .height(28)
                            .into()
                    }
                } else {
                    text(
                        if entry.icon.chars().count() <= 4 && !entry.icon.is_empty() {
                            &entry.icon
                        } else {
                            "󰀻"
                        },
                    )
                    .font(if entry.icon_font == "omarchy" {
                        iced::Font::with_name("omarchy")
                    } else {
                        iced::Font::DEFAULT
                    })
                    .size(22)
                    .width(32)
                    .into()
                };
                let subtitle = entry.subtitle.replace('\n', " ");
                let subtitle: String = subtitle.chars().take(85).collect();
                let trailing = if self.extension.is_some() {
                    self.extension_view.accessory(entry)
                } else if favorite {
                    "★".into()
                } else if matches!(entry.action, Action::Menu(_) | Action::Builtin(_)) {
                    "›".into()
                } else {
                    String::new()
                };
                let body = row![
                    icon,
                    column![
                        text(&entry.title).size(15),
                        text(subtitle).size(11).color(colors.muted)
                    ]
                    .spacing(3)
                    .width(Fill),
                    text(trailing).color(colors.accent)
                ]
                .spacing(12)
                .align_y(iced::Alignment::Center);
                list = list.push(
                    button(body)
                        .padding([9, 14])
                        .height(Fixed(56.0))
                        .width(Fill)
                        .style(move |_, s| colors.row(selected, s))
                        .on_press(Message::Activate(index)),
                );
            }
            let list = scrollable(list.padding([0, 8]))
                .id("results")
                .direction(scrollable::Direction::Vertical(
                    if self.config.show_scrollbar {
                        scrollable::Scrollbar::default()
                    } else {
                        scrollable::Scrollbar::new().width(0).scroller_width(0)
                    },
                ))
                .height(Fill)
                .width(Fill);
            if let Some(detail) = self
                .extension_view
                .selected_detail(self.results.get(self.selected))
            {
                row![
                    list,
                    widget::rule::vertical(1),
                    scrollable(self.extension_view.detail(detail, colors))
                        .height(Fill)
                        .width(Fill)
                ]
                .into()
            } else if self.route == "clipboard"
                && let Some(entry) = self.results.get(self.selected)
            {
                let preview: Element<'_, Message> = match &entry.action {
                    Action::Copy(value) => scrollable(text(value).size(14)).height(Fill).into(),
                    Action::CopyImage(path) => {
                        widget::image(widget::image::Handle::from_path(path))
                            .width(Fill)
                            .height(Fill)
                            .content_fit(iced::ContentFit::Contain)
                            .into()
                    }
                    _ => widget::Space::new().into(),
                };
                row![
                    list,
                    widget::rule::vertical(1),
                    container(preview).padding(12).width(Fill).height(Fill)
                ]
                .into()
            } else {
                list.into()
            }
        };
        let is_form = self
            .extension_view
            .root()
            .is_some_and(|root| root.kind == "Form");
        let mut body = column![header.padding([4, 14]).align_y(iced::Alignment::Center)].spacing(0);
        if self.settings.is_some() {
            body = body.push(container(text("Settings").size(20)).padding([10, 18]));
        } else if is_form
            || self
                .extension_view
                .root()
                .is_some_and(|root| root.kind == "Detail")
        {
            let title = self.extension_view.root().unwrap().text("navigationTitle");
            if !title.is_empty() {
                body = body.push(container(text(title).size(20)).padding([10, 18]));
            }
        } else {
            let mut search_row = row![search].align_y(iced::Alignment::Center);
            if let Some(accessory) = self.extension_view.search_accessory() {
                search_row = search_row.push(accessory);
            }
            body = body.push(search_row);
        }
        if self
            .extension_view
            .root()
            .is_some_and(|root| root.props["isLoading"] == true)
        {
            body = body.push(text("Loading…").size(11).color(colors.accent));
        }
        body = body.push(widget::rule::horizontal(1)).push(content);
        if !self.status.is_empty() {
            body = body.push(text(&self.status).size(11).color(colors.accent));
        }
        body = body.push(widget::rule::horizontal(1)).push(
            row![
                text(if is_form || self.settings.is_some() {
                    String::new()
                } else {
                    format!("{} results", self.results.len())
                })
                .size(11)
                .color(colors.muted),
                widget::Space::new().width(Fill),
                text(if is_form {
                    "Tab Next field   Esc Back"
                } else if self.settings.is_some() {
                    "Tab Next setting   Esc Back"
                } else {
                    "↑↓ Navigate   ↵ Open   Esc Back"
                })
                .size(11)
                .color(colors.muted),
                button(text("Actions  Ctrl K").size(11))
                    .style(move |_, s| colors.row(false, s))
                    .on_press(Message::Actions)
            ]
            .align_y(iced::Alignment::Center)
            .spacing(16)
            .padding([8, 14]),
        );
        let surface = container(body)
            .width(Fill)
            .height(Fill)
            .style(move |_| colors.panel());
        if !self.actions {
            return surface.into();
        }
        let mut choices = column![].spacing(2);
        for (index, (title, _)) in self.panel_items().into_iter().enumerate() {
            let selected = index == self.action_selected;
            choices = choices.push(
                button(text(title).size(14))
                    .width(Fill)
                    .padding([10, 12])
                    .style(move |_, status| colors.row(selected, status))
                    .on_press(Message::ActionChoice(index)),
            );
        }
        let rect = self.context.launcher_rect(&self.config);
        let title = self
            .action_path
            .last()
            .and_then(|id| self.extension_view.find(id))
            .map_or("Actions", |node| node.text("title"));
        let panel = container(
            column![
                text(title).size(14).color(colors.muted),
                text_input("Search actions…", &self.action_query)
                    .id("action-search")
                    .on_input(Message::ActionQuery)
                    .on_submit(Message::ActionChoice(self.action_selected))
                    .padding(10),
                scrollable(choices)
                    .id("action-choices")
                    .height((rect.height - 180.0).clamp(80.0, 250.0))
            ]
            .spacing(8)
            .padding(12),
        )
        .width((rect.width - 24.0).min(390.0))
        .style(move |_| colors.panel());
        widget::stack![
            surface,
            container(panel)
                .align_right(Fill)
                .align_bottom(Fill)
                .padding(12)
        ]
        .into()
    }
}

fn execute_action(action: Action, paste: bool) -> Result<(), String> {
    let mut process = match action {
        Action::Shell(command) => {
            let mut p = Command::new("bash");
            p.args(["-lc", &command]);
            p
        }
        Action::Desktop(path) => {
            let mut p = Command::new("gio");
            p.args(["launch", &path]);
            p
        }
        Action::Open(path) => {
            let mut p = Command::new("xdg-open");
            p.arg(path);
            p
        }
        Action::Window { operation, target } => return windows::operate(&operation, &target),
        Action::Copy(text) => {
            let mut child = Command::new("wl-copy")
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            child
                .stdin
                .take()
                .ok_or("Clipboard input unavailable")?
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string())?;
            if !child.wait().map_err(|e| e.to_string())?.success() {
                return Err("Could not copy to the Wayland clipboard".into());
            }
            if paste {
                paste_clipboard()?;
            }
            return Ok(());
        }
        Action::CopyImage(path) => {
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let status = Command::new("wl-copy")
                .args([
                    "--type",
                    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                        "image/jpeg"
                    } else {
                        "image/png"
                    },
                ])
                .stdin(file)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Could not copy image to the Wayland clipboard".into());
            }
            if paste {
                paste_clipboard()?;
            }
            return Ok(());
        }
        _ => return Err("This action is not available yet".into()),
    };
    process
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("Command exited with {status}"))
            }
        })
}

fn paste_clipboard() -> Result<(), String> {
    std::thread::sleep(std::time::Duration::from_millis(150));
    windows::paste()
}
