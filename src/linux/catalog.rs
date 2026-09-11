use super::{
    desktop,
    menu::Menu,
    model::{Action, Config, Entry, home},
    ranking::{self, Activity, Ranks},
};
use nucleo_matcher::{
    Matcher, Utf32Str,
    pattern::{CaseMatching, Normalization, Pattern},
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    process::Command,
    time::Instant,
};

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub menu: Menu,
    pub apps: Vec<Entry>,
    pub extensions: Vec<Entry>,
    pub extension_management: Vec<Entry>,
    pub ranks: Ranks,
    pub activity: Activity,
    pub ranking_loaded_at: Option<Instant>,
    pub ranking_updates: HashMap<String, Instant>,
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
        let mut catalog = Self {
            ranking_loaded_at: Some(Instant::now()),
            ..Self::default()
        };
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
        if let Ok((ranks, activity)) = ranking::load() {
            catalog.ranks = ranks;
            catalog.activity = activity;
        } else {
            catalog.ranking_loaded_at = None;
        }
        checkpoint("ranking");
        (catalog, timings)
    }

    pub fn record(&mut self, id: &str) {
        let now = ranking::now();
        match ranking::record(id, now) {
            Ok((rank, usage)) => {
                self.ranks.insert(id.into(), rank);
                self.activity.insert(id.into(), usage);
            }
            Err(_) => {
                let rank = self.ranks.entry(id.into()).or_default();
                rank.0 = rank.0.saturating_add(1);
                let usage = self.activity.entry(id.into()).or_default();
                *usage = usage.record(now);
            }
        }
        self.ranking_updates.insert(id.into(), Instant::now());
    }

    pub fn favorite(&mut self, id: &str) {
        match ranking::favorite(id, ranking::now()) {
            Ok((rank, usage)) => {
                self.ranks.insert(id.into(), rank);
                self.activity.insert(id.into(), usage);
            }
            Err(_) => {
                let rank = self.ranks.entry(id.into()).or_default();
                rank.1 = !rank.1;
            }
        }
        self.ranking_updates.insert(id.into(), Instant::now());
    }

    pub fn preserve_local_ranking(&mut self, previous: &Self) {
        if self.ranking_loaded_at.is_none() {
            self.ranks.extend(previous.ranks.clone());
            self.activity.extend(previous.activity.clone());
        }
        for (id, updated_at) in &previous.ranking_updates {
            if self
                .ranking_loaded_at
                .is_none_or(|loaded_at| *updated_at >= loaded_at)
            {
                if let Some(rank) = previous.ranks.get(id) {
                    self.ranks.insert(id.clone(), *rank);
                }
                if let Some(usage) = previous.activity.get(id) {
                    self.activity.insert(id.clone(), *usage);
                }
            }
            self.ranking_updates.insert(id.clone(), *updated_at);
        }
    }

    fn inventory(&self, config: &Config) -> Vec<Entry> {
        let mut entries = self.menu.entries("root", true);
        entries.extend(self.apps.clone());
        entries.extend(self.extensions.clone());
        entries.extend(self.extension_management.clone());
        entries.extend(builtins());
        entries.extend(super::windows::entries());
        entries.extend(configured_entries(config));
        entries
    }

    fn hidden_keys(&self, config: &Config, apps: &[Entry]) -> HashSet<String> {
        let mut keys: HashSet<_> = config.blacklist.iter().cloned().collect();
        if !keys.is_empty() {
            let mut entries = self.menu.entries("root", true);
            entries.extend(builtins());
            entries.extend(super::windows::entries());
            entries.extend(configured_entries(config));
            for entry in entries
                .iter()
                .chain(apps)
                .chain(&self.extensions)
                .chain(&self.extension_management)
            {
                if config.is_hidden(entry) {
                    keys.insert(entry.hidden_key());
                }
            }
        }
        keys
    }

    pub fn hidden_entries(&self, config: &Config) -> Vec<Entry> {
        let inventory = self.inventory(config);
        let mut seen = HashSet::new();
        let mut entries: Vec<_> = config
            .blacklist
            .iter()
            .filter(|key| seen.insert(key.as_str()))
            .map(|key| {
                let metadata = config
                    .hidden_actions
                    .iter()
                    .find(|hidden| &hidden.key == key);
                let original = inventory.iter().find(|entry| {
                    &entry.id == key
                        || &entry.hidden_key() == key
                        || entry.title.eq_ignore_ascii_case(key)
                });
                let menu = self.menu.items.iter().find(|item| &item.id == key);
                let title = metadata
                    .map(|hidden| hidden.title.as_str())
                    .or_else(|| original.map(|entry| entry.title.as_str()))
                    .or_else(|| menu.map(|item| item.label.as_str()))
                    .unwrap_or(key);
                let icon = metadata
                    .map(|hidden| hidden.icon.as_str())
                    .or_else(|| original.map(|entry| entry.icon.as_str()))
                    .or_else(|| menu.map(|item| item.icon.as_str()))
                    .filter(|icon| !icon.is_empty())
                    .unwrap_or("icon:EyeDisabled");
                let mut entry = Entry::new(
                    &format!("hidden:{key}"),
                    title,
                    "Restore action",
                    icon,
                    Action::Builtin(format!("unhide:{key}")),
                );
                entry.icon_font = metadata
                    .map(|hidden| hidden.icon_font.clone())
                    .or_else(|| original.map(|entry| entry.icon_font.clone()))
                    .or_else(|| menu.map(|item| item.icon_font.clone()))
                    .unwrap_or_default();
                entry.keywords = key.clone();
                entry
            })
            .collect();
        entries.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        entries
    }

    pub fn search(
        &self,
        route: &str,
        query: &str,
        config: &Config,
        dynamic: &[Entry],
    ) -> Vec<Entry> {
        self.search_at(route, query, config, dynamic, ranking::now())
    }

    pub fn search_dynamic(&self, query: &str, config: &Config, dynamic: &[Entry]) -> Vec<Entry> {
        self.search_dynamic_at(query, config, dynamic, ranking::now())
    }

    fn search_dynamic_at(
        &self,
        query: &str,
        config: &Config,
        dynamic: &[Entry],
        now: i64,
    ) -> Vec<Entry> {
        self.score_entries_at(
            "apps",
            query,
            config,
            dynamic.iter(),
            &self.hidden_keys(config, dynamic),
            now,
        )
    }

    fn search_at(
        &self,
        route: &str,
        query: &str,
        config: &Config,
        dynamic: &[Entry],
        now: i64,
    ) -> Vec<Entry> {
        if route == "apps" {
            return self.search_dynamic_at(query, config, &self.apps, now);
        }
        let expanded = config
            .aliases
            .get(query)
            .map(String::as_str)
            .unwrap_or(query);
        let entries = match route {
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
            "files" => vec![],
            "hidden" => self.hidden_entries(config),
            "extensions" => {
                let mut entries = self.extension_management.clone();
                entries.extend(self.extensions.clone());
                entries
            }
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
                all.extend(super::windows::entries());
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
                if route == "root" {
                    if !expanded.is_empty() {
                        entries.extend(self.apps.clone());
                        entries.extend(self.extensions.clone());
                        entries.extend(self.extension_management.clone());
                        entries.extend(super::windows::entries());
                    }
                    entries.extend(builtins());
                    entries.extend(configured_entries(config));
                }
                entries
            }
        };
        let dynamic = if matches!(
            route,
            "clipboard"
                | "emoji"
                | "extensions"
                | "apps"
                | "windows"
                | "settings"
                | "favorites"
                | "recent"
                | "hidden"
        ) {
            &[]
        } else {
            dynamic
        };
        self.score_entries_at(
            route,
            query,
            config,
            entries.iter().chain(dynamic),
            &self.hidden_keys(config, &self.apps),
            now,
        )
    }

    fn score_entries_at<'a>(
        &self,
        route: &str,
        query: &str,
        config: &Config,
        entries: impl Iterator<Item = &'a Entry>,
        hidden_keys: &HashSet<String>,
        now: i64,
    ) -> Vec<Entry> {
        let expanded = config
            .aliases
            .get(query)
            .map(String::as_str)
            .unwrap_or(query);
        let hidden = |entry: &Entry| {
            if hidden_keys.is_empty() || !entry.can_hide() {
                return false;
            }
            let key = entry.hidden_key();
            hidden_keys.contains(&entry.id)
                || hidden_keys.contains(&key)
                || config
                    .blacklist
                    .iter()
                    .any(|key| key.eq_ignore_ascii_case(&entry.title))
        };
        let pattern = Pattern::parse(expanded, CaseMatching::Ignore, Normalization::Smart);
        let expanded_lower = expanded.to_lowercase();
        let mut matcher = Matcher::new(nucleo_matcher::Config::DEFAULT);
        let mut buffer = Vec::new();
        let mut haystack = String::new();
        let mut scored = entries
            .filter(|entry| !hidden(entry))
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
                let score = if expanded.is_empty() {
                    Some(0)
                } else {
                    haystack.clear();
                    for value in [
                        entry.title.as_str(),
                        entry.subtitle.as_str(),
                        entry.keywords.as_str(),
                        contents,
                    ] {
                        haystack.push_str(value);
                        haystack.push(' ');
                    }
                    pattern.score(Utf32Str::new(&haystack, &mut buffer), &mut matcher)
                }?;
                let (uses, favorite) = self.ranks.get(&entry.id).copied().unwrap_or_default();
                let title_bonus =
                    if !expanded.is_empty() && entry.title.eq_ignore_ascii_case(expanded) {
                        1000
                    } else if !expanded.is_empty()
                        && entry.title.to_lowercase().starts_with(&expanded_lower)
                    {
                        100
                    } else {
                        0
                    };
                Some((
                    entry,
                    i64::from(score)
                        + title_bonus
                        + self
                            .activity
                            .get(&entry.id)
                            .map_or(uses.clamp(0, 20), |usage| usage.bonus(now))
                        + if favorite { 40 } else { 0 },
                    order,
                ))
            })
            .collect::<Vec<_>>();
        let compare =
            |a: &(&Entry, i64, usize), b: &(&Entry, i64, usize)| b.1.cmp(&a.1).then(a.2.cmp(&b.2));
        if route == "root" && !expanded.is_empty() {
            let mut targets = HashMap::new();
            let mut unique: Vec<(&Entry, i64, usize)> = Vec::with_capacity(scored.len());
            for candidate in scored {
                if let Action::Extension { extension, command } = &candidate.0.action {
                    let key = (extension.as_str(), command.as_str());
                    if let Some(&index) = targets.get(&key) {
                        if compare(&candidate, &unique[index]).is_lt() {
                            unique[index] = candidate;
                        }
                        continue;
                    }
                    targets.insert(key, unique.len());
                }
                unique.push(candidate);
            }
            scored = unique;
        }
        if scored.len() > config.max_results {
            scored.select_nth_unstable_by(config.max_results, compare);
            scored.truncate(config.max_results);
        }
        scored.sort_by(compare);
        let mut results: Vec<_> = scored
            .into_iter()
            .take(config.max_results)
            .map(|(e, _, _)| e.clone())
            .collect();
        if route == "root" && !expanded.is_empty() {
            let mut quick = quick_results(expanded, config);
            quick.retain(|entry| !hidden(entry));
            quick.append(&mut results);
            results = quick;
        }
        results
    }
}

fn configured_entries(config: &Config) -> Vec<Entry> {
    let mut entries: Vec<_> = config
        .shells
        .iter()
        .map(|shell| {
            let mut entry = Entry::new(
                &format!("shell:{}", shell.name),
                &shell.name,
                &shell.description,
                &shell.icon,
                Action::Shell(shell.command.clone()),
            );
            entry.keywords = shell.alias.clone().unwrap_or_default();
            entry
        })
        .collect();
    entries.extend(config.modes.keys().map(|mode| {
        Entry::new(
            &format!("mode:{mode}"),
            mode,
            "Custom mode",
            "󰘦",
            Action::Builtin(format!("mode:{mode}")),
        )
    }));
    entries
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
            "File and Folder Search",
            "Find files and folders by name or path",
            "icon:Folder",
        ),
        (
            "extensions",
            "Extensions",
            "Browse and manage extensions",
            "󰏗",
        ),
        ("favorites", "Favorites", "Your pinned commands", ""),
        (
            "updates",
            "Check for Updates",
            "Download new Linux releases",
            "",
        ),
        ("recent", "Frequently Used", "Commands ranked by use", "󰥔"),
        ("settings", "Settings", "Configure your launcher", ""),
        (
            "hidden",
            "Hidden Actions",
            "Restore actions hidden from search",
            "icon:EyeDisabled",
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
            | "hidden"
            | "extensions"
            | "favorites"
            | "recent"
            | "packages"
            | "windows"
            | "running"
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
            "bash -lc {} super-space {}",
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
            "Reload Super Space",
            "Refresh configuration, menu, apps, and extensions",
            "",
            Action::Builtin("refresh".into()),
        )),
        "version" => entries.push(Entry::new(
            "version",
            &format!("Super Space {}", env!("CARGO_PKG_VERSION")),
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
        "quit super space" => entries.push(Entry::new(
            "quit-launcher",
            "Quit Super Space",
            "Stop the launcher",
            "󰅖",
            Action::Builtin("quit".into()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_search_keeps_the_best_match_for_each_extension_command() {
        let entry = |id: &str, title: &str, command: &str| {
            Entry::new(
                id,
                title,
                "",
                "",
                Action::Extension {
                    extension: "fixture".into(),
                    command: command.into(),
                },
            )
        };
        let catalog = Catalog {
            extensions: vec![
                entry("native", "Unique workflow settings", "first"),
                entry("extension", "Unique workflow", "first"),
                entry("second", "Unique workflow tool", "second"),
            ],
            ..Default::default()
        };
        let config = Config {
            max_results: 2,
            ..Default::default()
        };
        let results = catalog.search("root", "Unique workflow", &config, &[]);
        assert_eq!(
            results
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["extension", "second"]
        );
    }

    #[test]
    fn favorite_and_recent_window_commands_remain_available() {
        let target = super::super::windows::entries().into_iter().find(|entry| {
            matches!(&entry.action, Action::Window { operation, .. } if operation == "left-half")
        }).unwrap();
        let mut catalog = Catalog::default();
        catalog.ranks.insert(target.id.clone(), (2, true));
        for route in ["favorites", "recent"] {
            let results = catalog.search(route, "", &Config::default(), &[]);
            assert!(results.iter().any(|entry| entry.id == target.id));
        }
    }

    #[test]
    fn dynamic_search_limits_keep_ranked_order_and_blacklists() {
        let dynamic = (0..200)
            .map(|index| {
                let name = format!("tool-{index:03}");
                Entry::new(&name, &name, "Package", "", Action::Copy(name.clone()))
            })
            .collect::<Vec<_>>();
        let mut catalog = Catalog::default();
        catalog.ranks.insert("tool-190".into(), (0, true));
        let config = Config {
            max_results: 3,
            blacklist: vec!["tool-000".into()],
            ..Default::default()
        };
        let result = catalog.search("install.aur", "tool", &config, &dynamic);
        assert_eq!(
            result
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["tool-190", "tool-001", "tool-002"]
        );
        let result = catalog.search("install.aur", "tool-042", &config, &dynamic);
        assert_eq!(result[0].id, "tool-042");
        assert!(catalog.search("apps", "tool", &config, &dynamic).is_empty());
    }

    fn application(id: &str, title: &str) -> Entry {
        Entry::new(id, title, "Application", "", Action::Copy(id.into()))
    }

    #[test]
    fn frequent_firefox_rises_for_f_without_overriding_exact_or_unrelated_queries() {
        let now = 2_000_000_000;
        let mut catalog = Catalog {
            apps: vec![
                application("files", "Files"),
                application("foot", "Foot"),
                application("firefox", "Firefox"),
                application("chrome", "Chrome"),
            ],
            ..Default::default()
        };
        let config = Config::default();
        let search = |catalog: &Catalog, query| catalog.search_at("apps", query, &config, &[], now);
        assert_ne!(search(&catalog, "f")[0].id, "firefox");
        catalog.activity.insert(
            "firefox".into(),
            ranking::Usage {
                weight: 12.,
                updated_at: now,
            },
        );
        catalog.ranks.insert("firefox".into(), (12, false));
        assert_eq!(search(&catalog, "F")[0].id, "firefox");
        assert_eq!(search(&catalog, "files")[0].id, "files");
        assert_eq!(search(&catalog, "foot")[0].id, "foot");
        assert_eq!(search(&catalog, "chrome")[0].id, "chrome");
        assert!(
            search(&catalog, "chrome")
                .iter()
                .all(|entry| entry.id != "firefox")
        );
        assert_eq!(search(&catalog, "ffx")[0].id, "firefox");
    }

    #[test]
    fn recent_habits_replace_old_habits_and_pins_remain_effective() {
        let now = 2_000_000_000;
        let mut catalog = Catalog {
            apps: vec![
                application("files", "Files"),
                application("firefox", "Firefox"),
            ],
            ..Default::default()
        };
        catalog.activity.insert(
            "files".into(),
            ranking::Usage {
                weight: 100.,
                updated_at: now - 140 * 86_400,
            },
        );
        catalog.activity.insert(
            "firefox".into(),
            ranking::Usage {
                weight: 3.,
                updated_at: now,
            },
        );
        let config = Config::default();
        assert_eq!(
            catalog.search_at("apps", "f", &config, &[], now)[0].id,
            "firefox"
        );
        catalog.ranks.insert("files".into(), (100, true));
        assert_eq!(
            catalog.search_at("apps", "f", &config, &[], now)[0].id,
            "files"
        );
    }

    #[test]
    fn asynchronous_catalog_refresh_preserves_newer_launches_and_pin_changes() {
        let loaded_at = Instant::now();
        let mut previous = Catalog::default();
        previous.ranks.insert("firefox".into(), (6, false));
        previous.activity.insert(
            "firefox".into(),
            ranking::Usage {
                weight: 6.,
                updated_at: 200,
            },
        );
        previous.ranking_updates.insert("firefox".into(), loaded_at);
        let mut refreshed = Catalog {
            ranking_loaded_at: Some(loaded_at),
            ..Default::default()
        };
        refreshed.ranks.insert("firefox".into(), (5, true));
        refreshed.activity.insert(
            "firefox".into(),
            ranking::Usage {
                weight: 5.,
                updated_at: 100,
            },
        );
        refreshed.preserve_local_ranking(&previous);
        assert_eq!(refreshed.ranks["firefox"], (6, false));
        assert_eq!(refreshed.activity["firefox"], previous.activity["firefox"]);
        let mut later = Catalog {
            ranking_loaded_at: Some(loaded_at + std::time::Duration::from_secs(1)),
            ..Default::default()
        };
        later.ranks.insert("firefox".into(), (7, true));
        later.preserve_local_ranking(&refreshed);
        assert_eq!(later.ranks["firefox"], (7, true));
        let mut unavailable = Catalog::default();
        unavailable.preserve_local_ranking(&later);
        assert_eq!(unavailable.ranks["firefox"], (7, true));
    }

    #[test]
    fn hidden_extensions_do_not_resurface_through_aliases_favorites_or_recent() {
        let command = Action::Extension {
            extension: "tools".into(),
            command: "work".into(),
        };
        let direct = Entry::new(
            "extension:tools:work",
            "Work",
            "",
            "icon:Hammer",
            command.clone(),
        );
        let wrapper = Entry::new("omarchy.work", "Native Work", "", "icon:Hammer", command);
        let mut catalog = Catalog {
            extensions: vec![direct.clone(), wrapper.clone()],
            ..Default::default()
        };
        catalog.ranks.insert(direct.id.clone(), (100, true));
        catalog.ranks.insert(wrapper.id.clone(), (100, true));
        for key in [&direct.id, &wrapper.id, &wrapper.title] {
            let config = Config {
                blacklist: vec![key.clone()],
                ..Default::default()
            };
            for route in ["root", "extensions", "favorites", "recent"] {
                let results = catalog.search_at(route, "work", &config, &[], 2_000_000_000);
                assert!(
                    results
                        .iter()
                        .all(|entry| !matches!(entry.action, Action::Extension { .. })),
                    "{route}: {key}"
                );
            }
            let hidden = catalog.search_at("hidden", "work", &config, &[], 2_000_000_000);
            assert_eq!(hidden.len(), 1);
            assert_eq!(hidden[0].action, Action::Builtin(format!("unhide:{key}")));
        }
    }

    #[test]
    fn hidden_dynamic_entries_restore_by_metadata_without_loading_their_provider() {
        let config = Config {
            blacklist: vec!["file:/tmp/Report, final.pdf".into()],
            hidden_actions: vec![super::super::model::HiddenAction {
                key: "file:/tmp/Report, final.pdf".into(),
                title: "Report, final.pdf".into(),
                icon: "icon:Document".into(),
                icon_font: String::new(),
            }],
            ..Default::default()
        };
        let hidden = Catalog::default().search("hidden", "report", &config, &[]);
        assert_eq!(hidden[0].title, "Report, final.pdf");
        assert_eq!(hidden[0].icon, "icon:Document");
        assert_eq!(
            hidden[0].action,
            Action::Builtin("unhide:file:/tmp/Report, final.pdf".into())
        );
    }

    #[test]
    fn hidden_quick_actions_are_filtered_and_f_uses_adaptive_application_ranking() {
        let config = Config {
            blacklist: vec!["calculator".into(), "run-shell".into(), "open-url".into()],
            ..Default::default()
        };
        let mut catalog = Catalog::default();
        for query in ["2+2", "> echo hello", "https://example.com"] {
            assert!(
                catalog
                    .search("root", query, &config, &[])
                    .iter()
                    .all(|entry| !config.is_hidden(entry))
            );
        }
        catalog.apps = vec![
            application("app:files", "Files"),
            application("app:firefox", "Firefox"),
        ];
        catalog.activity.insert(
            "app:firefox".into(),
            ranking::Usage {
                weight: 12.,
                updated_at: 2_000_000_000,
            },
        );
        assert_eq!(
            catalog.search_at("root", "f", &config, &[], 2_000_000_000)[0].id,
            "app:firefox"
        );
    }

    fn cloned_dynamic_search(
        catalog: &Catalog,
        query: &str,
        config: &Config,
        dynamic: &[Entry],
        now: i64,
    ) -> Vec<Entry> {
        let mut catalog = catalog.clone();
        catalog.apps = dynamic.to_vec();
        let entries = catalog.apps.clone();
        let mut hidden_keys: HashSet<_> = config.blacklist.iter().cloned().collect();
        if !hidden_keys.is_empty() {
            for entry in catalog.inventory(config) {
                if config.is_hidden(&entry) {
                    hidden_keys.insert(entry.hidden_key());
                }
            }
        }
        catalog.score_entries_at("apps", query, config, entries.iter(), &hidden_keys, now)
    }

    fn synthetic_packages(count: usize) -> Vec<Entry> {
        (0..count)
            .map(|index| {
                let name = format!(
                    "{}-{index:06}",
                    ["rust", "firefox", "zellij", "python"][index % 4]
                );
                let mut entry = Entry::new(
                    &format!("package:{name}"),
                    &name,
                    "1.0.0 · Installed package with search metadata",
                    "icon:Box",
                    Action::Builtin(format!("package:{name}")),
                );
                entry.keywords = "tools development package".into();
                entry.icon_font = "Symbols Nerd Font".into();
                entry
            })
            .collect()
    }

    #[test]
    fn borrowed_dynamic_search_preserves_clone_path_results_and_metadata() {
        let now = 2_000_000_000;
        let mut dynamic = synthetic_packages(300);
        let command = Action::Extension {
            extension: "tools".into(),
            command: "work".into(),
        };
        dynamic.extend([
            Entry::new("dynamic-work", "Work", "", "icon:Hammer", command.clone()),
            Entry::new(
                "dynamic-alias",
                "Work alias",
                "",
                "icon:Hammer",
                command.clone(),
            ),
            Entry::new(
                "mode-item:first",
                "Shell work",
                "",
                "",
                Action::Shell("printf work".into()),
            ),
            Entry::new(
                "mode-item:alias",
                "Shell alias",
                "",
                "",
                Action::Shell("printf work".into()),
            ),
            Entry::new(
                "restore",
                "Restore",
                "",
                "",
                Action::Builtin("unhide:old".into()),
            ),
            application("unicode", "Résumé café"),
        ]);
        let mut catalog = Catalog {
            apps: vec![Entry::new("catalog-only", "Existing work", "", "", command)],
            ..Default::default()
        };
        catalog.ranks.insert(dynamic[190].id.clone(), (10, true));
        catalog.activity.insert(
            dynamic[290].id.clone(),
            ranking::Usage {
                weight: 12.,
                updated_at: now,
            },
        );
        for blacklist in [
            vec![],
            vec![dynamic[0].id.clone(), "PYTHON-000003".into()],
            vec!["dynamic-alias".into()],
            vec!["WORK ALIAS".into()],
            vec!["mode-item:first".into()],
            vec!["catalog-only".into()],
            vec!["restore".into()],
        ] {
            for max_results in [0, 1, 3, 80, 1000] {
                let config = Config {
                    max_results,
                    blacklist: blacklist.clone(),
                    aliases: HashMap::from([("dev".into(), "tools".into())]),
                    ..Default::default()
                };
                for query in [
                    "",
                    "rust",
                    "FIREFOX",
                    "rust-000004",
                    "dev",
                    "work",
                    "shell",
                    "resume",
                    "missing",
                ] {
                    let expected = cloned_dynamic_search(&catalog, query, &config, &dynamic, now);
                    let actual = catalog.search_dynamic_at(query, &config, &dynamic, now);
                    assert_eq!(
                        serde_json::to_value(&actual).unwrap(),
                        serde_json::to_value(&expected).unwrap(),
                        "query={query:?}, limit={max_results}, blacklist={blacklist:?}"
                    );
                }
            }
        }
        let hidden_alias = Config {
            blacklist: vec!["dynamic-alias".into()],
            ..Default::default()
        };
        assert!(
            catalog
                .search_dynamic_at("work", &hidden_alias, &dynamic, now)
                .iter()
                .all(|entry| { !matches!(&entry.action, Action::Extension { .. }) })
        );
        let replaced_app = Config {
            blacklist: vec!["catalog-only".into()],
            ..Default::default()
        };
        assert_eq!(
            catalog
                .search_dynamic_at("work", &replaced_app, &dynamic, now)
                .iter()
                .filter(|entry| { matches!(&entry.action, Action::Extension { .. }) })
                .count(),
            2
        );
    }

    #[test]
    #[ignore = "Compares cloned and borrowed search over 100,000 synthetic packages"]
    fn dynamic_catalog_search_profile() {
        let dynamic = synthetic_packages(100_000);
        let mut catalog = Catalog {
            apps: synthetic_packages(1000),
            ..Default::default()
        };
        catalog.ranks.insert(dynamic[99_990].id.clone(), (10, true));
        let now = 2_000_000_000;
        for blacklist in [vec![], vec![dynamic[0].id.clone()]] {
            let config = Config {
                blacklist,
                ..Default::default()
            };
            for query in ["", "rust", "firefox", "zellij", "python", "missing"] {
                let expected = cloned_dynamic_search(&catalog, query, &config, &dynamic, now);
                let actual = catalog.search_dynamic_at(query, &config, &dynamic, now);
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap()
                );
                let mut cloned = Vec::new();
                let mut borrowed = Vec::new();
                for iteration in 0..9 {
                    for legacy in if iteration % 2 == 0 {
                        [true, false]
                    } else {
                        [false, true]
                    } {
                        let started = Instant::now();
                        let result = if legacy {
                            cloned_dynamic_search(&catalog, query, &config, &dynamic, now)
                        } else {
                            catalog.search_dynamic_at(query, &config, &dynamic, now)
                        };
                        drop(std::hint::black_box(result));
                        let elapsed = started.elapsed().as_secs_f64() * 1000.;
                        if legacy {
                            cloned.push(elapsed);
                        } else {
                            borrowed.push(elapsed);
                        }
                    }
                }
                cloned.sort_by(f64::total_cmp);
                borrowed.sort_by(f64::total_cmp);
                println!(
                    "dynamic entries={} hidden={} query={query:?} cloned_median_ms={:.3} borrowed_median_ms={:.3} speedup={:.2}x",
                    dynamic.len(),
                    config.blacklist.len(),
                    cloned[4],
                    borrowed[4],
                    cloned[4] / borrowed[4]
                );
            }
        }
    }

    #[test]
    #[ignore = "Profiles the installed AUR catalog"]
    fn aur_catalog_search_profile() {
        let menu = Menu::load().unwrap();
        let dynamic = menu.provider("install.aur");
        assert!(dynamic.len() > 100_000);
        let catalog = Catalog::default();
        let config = Config::default();
        let mut samples = Vec::new();
        for query in ["", "rust", "firefox", "zellij", "python"] {
            let started = std::time::Instant::now();
            let result = catalog.search("install.aur", query, &config, &dynamic);
            assert!(!result.is_empty());
            samples.push((query, started.elapsed().as_secs_f64() * 1000.));
        }
        println!("AUR entries={}, search_ms={samples:?}", dynamic.len());
    }
}
