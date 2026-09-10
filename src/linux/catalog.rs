use super::{
    desktop,
    menu::Menu,
    model::{Action, Config, Entry, home, state_dir},
};
use nucleo_matcher::{
    Matcher, Utf32Str,
    pattern::{CaseMatching, Normalization, Pattern},
};
use rusqlite::{Connection, params};
use std::{collections::HashMap, fs, process::Command};

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub menu: Menu,
    pub apps: Vec<Entry>,
    pub extensions: Vec<Entry>,
    pub extension_management: Vec<Entry>,
    pub ranks: HashMap<String, (i64, bool)>,
    pub errors: Vec<String>,
}

impl Catalog {
    pub fn load() -> Self {
        Self::load_profiled().0
    }

    pub fn load_profiled() -> (Self, Vec<(&'static str, f64)>) {
        let mut timings = Vec::new();
        let mut started = std::time::Instant::now();
        let mut checkpoint = |name| {
            timings.push((name, started.elapsed().as_secs_f64() * 1000.));
            started = std::time::Instant::now();
        };
        let mut catalog = Self::default();
        match Menu::load() {
            Ok(mut menu) => {
                menu.evaluate_conditions();
                catalog.menu = menu;
            }
            Err(error) => catalog.errors.push(error),
        }
        checkpoint("menu");
        catalog.apps = desktop::apps();
        checkpoint("applications_and_icons");
        catalog.extensions = super::extensions::entries();
        catalog.extension_management = super::extensions::management_entries("extension-manager");
        checkpoint("extensions");
        if let Ok(connection) = database()
            && let Ok(mut statement) = connection.prepare("SELECT id, uses, favorite FROM ranking")
            && let Ok(rows) = statement.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
        {
            catalog.ranks = rows.filter_map(Result::ok).collect();
        }
        checkpoint("ranking");
        (catalog, timings)
    }

    pub fn record(&mut self, id: &str) {
        self.ranks.entry(id.into()).or_default().0 += 1;
        if let Ok(connection) = database() {
            let _ = connection.execute("INSERT INTO ranking (id,uses,favorite) VALUES (?1,1,0) ON CONFLICT(id) DO UPDATE SET uses=uses+1", [id]);
        }
    }

    pub fn favorite(&mut self, id: &str) {
        let record = self.ranks.entry(id.into()).or_default();
        record.1 = !record.1;
        if let Ok(connection) = database() {
            let _ = connection.execute("INSERT INTO ranking (id,uses,favorite) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET favorite=excluded.favorite", params![id, record.0, record.1]);
        }
    }

    pub fn search(
        &self,
        route: &str,
        query: &str,
        config: &Config,
        dynamic: &[Entry],
    ) -> Vec<Entry> {
        let expanded = config
            .aliases
            .get(query)
            .map(String::as_str)
            .unwrap_or(query);
        let mut entries = match route {
            "clipboard" => clipboard(),
            "emoji" => emojis::iter()
                .map(|e| {
                    Entry::new(
                        &format!("emoji:{}", e.as_str()),
                        e.as_str(),
                        e.name(),
                        e.as_str(),
                        Action::Copy(e.as_str().into()),
                    )
                })
                .collect(),
            "files" => dynamic.to_vec(),
            "extensions" => {
                let mut entries = self.extension_management.clone();
                entries.extend(self.extensions.clone());
                entries
            }
            "apps" => self.apps.clone(),
            "windows" => super::windows::entries(),
            "settings" => vec![
                Entry::new(
                    "edit-config",
                    "Open configuration",
                    "Edit aliases, commands, modes, and search preferences",
                    "",
                    Action::Builtin("edit-config".into()),
                ),
                Entry::new(
                    "refresh",
                    "Reload configuration and commands",
                    "Refresh applications, extensions, and Omarchy menu",
                    "",
                    Action::Builtin("refresh".into()),
                ),
                Entry::new(
                    "clipboard-paste",
                    if config.clipboard_paste_on_select {
                        "Paste on select: On"
                    } else {
                        "Paste on select: Off"
                    },
                    "Automatically paste a chosen clipboard item into the previous window",
                    "󰅌",
                    Action::Builtin("clipboard-paste".into()),
                ),
            ],
            "favorites" | "recent" => {
                let mut all = self.menu.entries("root", true);
                all.extend(self.apps.clone());
                all.extend(self.extensions.clone());
                all.extend(builtins());
                all.retain(|e| {
                    self.ranks.get(&e.id).is_some_and(|(uses, favorite)| {
                        if route == "favorites" {
                            *favorite
                        } else {
                            *uses > 0
                        }
                    })
                });
                all
            }
            _ => {
                let mut entries = self.menu.entries(route, !expanded.is_empty());
                entries.extend(dynamic.iter().cloned());
                if route == "root" {
                    if !expanded.is_empty() {
                        entries.extend(self.apps.clone());
                        entries.extend(self.extensions.clone());
                        entries.extend(self.extension_management.clone());
                        entries.extend(super::windows::entries());
                    }
                    entries.extend(builtins());
                    entries.extend(config.shells.iter().map(|s| {
                        let mut entry = Entry::new(
                            &format!("shell:{}", s.name),
                            &s.name,
                            &s.description,
                            &s.icon,
                            Action::Shell(s.command.clone()),
                        );
                        entry.keywords = s.alias.clone().unwrap_or_default();
                        entry
                    }));
                    entries.extend(config.modes.keys().map(|mode| {
                        Entry::new(
                            &format!("mode:{mode}"),
                            mode,
                            "Custom mode",
                            "󰘦",
                            Action::Builtin(format!("mode:{mode}")),
                        )
                    }));
                }
                entries
            }
        };
        entries.retain(|e| {
            !config
                .blacklist
                .iter()
                .any(|b| b == &e.id || b.eq_ignore_ascii_case(&e.title))
        });
        let pattern = Pattern::parse(expanded, CaseMatching::Ignore, Normalization::Smart);
        let mut matcher = Matcher::new(nucleo_matcher::Config::DEFAULT);
        let mut scored = entries
            .into_iter()
            .enumerate()
            .filter_map(|(order, entry)| {
                let contents = if route == "clipboard" {
                    match &entry.action {
                        Action::Copy(value) => value.as_str(),
                        _ => "",
                    }
                } else {
                    ""
                };
                let haystack = format!(
                    "{} {} {} {}",
                    entry.title, entry.subtitle, entry.keywords, contents
                );
                let mut buffer = Vec::new();
                let score = if expanded.is_empty() {
                    Some(0)
                } else {
                    pattern.score(Utf32Str::new(&haystack, &mut buffer), &mut matcher)
                }?;
                let (uses, favorite) = self.ranks.get(&entry.id).copied().unwrap_or_default();
                let title_bonus =
                    if !expanded.is_empty() && entry.title.eq_ignore_ascii_case(expanded) {
                        1000
                    } else if !expanded.is_empty()
                        && entry
                            .title
                            .to_lowercase()
                            .starts_with(&expanded.to_lowercase())
                    {
                        100
                    } else {
                        0
                    };
                Some((
                    entry,
                    i64::from(score) + title_bonus + uses.min(20) + if favorite { 40 } else { 0 },
                    order,
                ))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
        let mut results: Vec<_> = scored
            .into_iter()
            .take(config.max_results)
            .map(|(e, _, _)| e)
            .collect();
        if route == "root" && !expanded.is_empty() {
            let mut quick = quick_results(expanded, config);
            quick.append(&mut results);
            results = quick;
        }
        results
    }
}

pub fn builtins() -> Vec<Entry> {
    [
        (
            "clipboard",
            "Clipboard History",
            "Text and images from your Omarchy clipboard",
            "󰅌",
        ),
        ("emoji", "Search Emoji", "Find and copy an emoji", ""),
        (
            "files",
            "Search Files",
            "Search your documents and development folders",
            "󰈔",
        ),
        (
            "extensions",
            "Extensions",
            "Installed TypeScript, JavaScript, and shell commands",
            "󰏗",
        ),
        ("favorites", "Favorites", "Your pinned commands", ""),
        (
            "updates",
            "Check for Command Space Updates",
            "Download new Linux releases",
            "",
        ),
        ("recent", "Frequently Used", "Commands ranked by use", "󰥔"),
        (
            "settings",
            "Command Space Settings",
            "Configure your launcher",
            "",
        ),
        (
            "packages",
            "Installed Packages",
            "Browse packages installed on this system",
            "󰏖",
        ),
        (
            "windows",
            "Window Management",
            "Tile, resize, and arrange the previous window",
            "󰖯",
        ),
        (
            "running",
            "Running Applications",
            "Switch to or quit an application window",
            "󰖯",
        ),
    ]
    .into_iter()
    .map(|(id, title, subtitle, icon)| {
        Entry::new(
            &format!("builtin:{id}"),
            title,
            subtitle,
            icon,
            Action::Builtin(id.into()),
        )
    })
    .collect()
}

pub fn is_builtin_route(route: &str) -> bool {
    matches!(
        route,
        "settings"
            | "clipboard"
            | "emoji"
            | "files"
            | "extensions"
            | "favorites"
            | "recent"
            | "packages"
            | "windows"
            | "running"
            | "lemon"
            | "updates"
    ) || route.starts_with("mode:")
}

fn quick_results(query: &str, config: &Config) -> Vec<Entry> {
    let mut entries = vec![];
    if let Some(command) = query.strip_prefix('>').filter(|v| !v.trim().is_empty()) {
        entries.push(Entry::new(
            "run-shell",
            &format!("Run {}", command.trim()),
            "Shell command",
            "",
            Action::Shell(command.into()),
        ));
    }
    if let Ok(arguments) = shell_words::split(query)
        && let Some(name) = arguments.first()
        && let Some(shell) = config
            .shells
            .iter()
            .find(|s| s.alias.as_ref() == Some(name) || &s.name == name)
    {
        let command = format!(
            "bash -lc {} command-space {}",
            super::model::shell_quote(&shell.command),
            arguments[1..]
                .iter()
                .map(|s| super::model::shell_quote(s))
                .collect::<Vec<_>>()
                .join(" ")
        );
        entries.push(Entry::new(
            &format!("shell:{}", shell.name),
            &shell.name,
            &format!("Arguments: {}", arguments[1..].join(" · ")),
            &shell.icon,
            Action::Shell(command),
        ));
    }
    match query {
        "refresh" => entries.push(Entry::new(
            "refresh",
            "Reload Command Space",
            "Refresh configuration, menu, apps, and extensions",
            "",
            Action::Builtin("refresh".into()),
        )),
        "version" => entries.push(Entry::new(
            "version",
            &format!("Command Space {}", env!("CARGO_PKG_VERSION")),
            "Version",
            "󰋽",
            Action::Copy(env!("CARGO_PKG_VERSION").into()),
        )),
        "quit all" => entries.push(Entry::new(
            "quit-all",
            "Quit All Applications",
            "Request all application windows to close",
            "󰅖",
            Action::Builtin("quit-all".into()),
        )),
        "quit command space" => entries.push(Entry::new(
            "quit-launcher",
            "Quit Command Space",
            "Stop the launcher",
            "󰅖",
            Action::Builtin("quit".into()),
        )),
        "67" => entries.push(Entry::new(
            "67",
            "67",
            "67",
            "67",
            Action::Copy("67".into()),
        )),
        "f" => entries.push(Entry::new(
            "ferris",
            "Ferris Plushies",
            "ferris.rs",
            "🦀",
            Action::Open("https://ferris.rs".into()),
        )),
        "zombo" => entries.push(Entry::new(
            "zombo",
            "Zombo",
            "zombo.com",
            "󰖟",
            Action::Open("https://zombo.com".into()),
        )),
        "lemon" => entries.push(Entry::new(
            "lemon",
            "Lemon",
            "🍋",
            "🍋",
            Action::Builtin("lemon".into()),
        )),
        _ => {}
    }
    if query.chars().any(|c| c.is_ascii_digit()) {
        if let Ok(value) = evalexpr::eval(query)
            && !matches!(value, evalexpr::Value::Empty | evalexpr::Value::Boolean(_))
        {
            let result = value.to_string();
            entries.push(Entry::new(
                "calculator",
                &result,
                query,
                "󰃬",
                Action::Copy(result.clone()),
            ));
        }
        if let Some(conversions) = crate::unit_conversion::convert_query(query) {
            for conversion in conversions {
                let result = format!(
                    "{} {}",
                    crate::unit_conversion::format_number(conversion.target_value),
                    conversion.target_unit.name
                );
                entries.push(Entry::new(
                    &format!("conversion:{}", conversion.target_unit.name),
                    &result,
                    query,
                    "⇄",
                    Action::Copy(result.clone()),
                ));
            }
        }
    }
    if let Some(query) = query.strip_suffix('?') {
        let encoded: String =
            url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect();
        entries.push(Entry::new(
            "web-search",
            &format!("Search the web for {}", query.trim()),
            "Open in your default browser",
            "󰖟",
            Action::Open(config.search_url.replace("%s", &encoded)),
        ));
    } else if query.starts_with("https://")
        || query.starts_with("http://")
        || (query.contains('.')
            && !query.contains(' ')
            && url::Url::parse(&format!("https://{query}")).is_ok())
    {
        let address = if query.contains("://") {
            query.into()
        } else {
            format!("https://{query}")
        };
        entries.push(Entry::new(
            "open-url",
            query,
            "Open website",
            "󰖟",
            Action::Open(address),
        ));
    }
    if query == "randomvar" {
        let value = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
            % 101;
        entries.push(Entry::new(
            "randomvar",
            &value.to_string(),
            "Random number from 0 to 100",
            "󰒝",
            Action::Copy(value.to_string()),
        ));
    }
    entries
}

fn clipboard_path() -> std::path::PathBuf {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home().join(".local/state"));
    state.join("omarchy/clipboard-history.json")
}

fn clipboard_id(value: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    let content = if value["type"] == "image" {
        value["path"].as_str()
    } else {
        value["text"].as_str()
    }
    .unwrap_or_default();
    format!(
        "clipboard:{}",
        Sha256::digest(content.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub fn remove_clipboard(id: Option<&str>) -> Result<(), String> {
    let path = clipboard_path();
    let mut items: Vec<serde_json::Value> =
        serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if let Some(id) = id {
        items.retain(|v| clipboard_id(v) != id);
    } else {
        items.clear();
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(
        serde_json::to_string_pretty(&items)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

pub fn clipboard() -> Vec<Entry> {
    let items: Vec<serde_json::Value> = fs::read(clipboard_path())
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    items
        .iter()
        .filter_map(|value| {
            if value["type"] == "image" {
                let path = value["path"].as_str()?;
                Some(Entry::new(
                    &clipboard_id(value),
                    "Image",
                    value["capturedAt"].as_str().unwrap_or("Clipboard image"),
                    path,
                    Action::CopyImage(path.into()),
                ))
            } else {
                let text = value["text"].as_str()?;
                let title = text
                    .lines()
                    .next()
                    .unwrap_or(text)
                    .chars()
                    .take(100)
                    .collect::<String>();
                Some(Entry::new(
                    &clipboard_id(value),
                    &title,
                    &format!("{} characters", text.chars().count()),
                    "󰅌",
                    Action::Copy(text.into()),
                ))
            }
        })
        .collect()
}

pub fn packages() -> Vec<Entry> {
    let Ok(output) = Command::new("pacman").args(["-Q"]).output() else {
        return vec![];
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, version) = line.split_once(' ')?;
            Some(Entry::new(
                &format!("package:{name}"),
                name,
                version,
                "󰏖",
                Action::Builtin(format!("package:{name}")),
            ))
        })
        .collect()
}

fn database() -> rusqlite::Result<Connection> {
    let _ = fs::create_dir_all(state_dir());
    let connection = Connection::open(state_dir().join("history.db"))?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS ranking(id TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0)")?;
    Ok(connection)
}
