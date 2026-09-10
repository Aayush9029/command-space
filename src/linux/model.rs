use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Action {
    Menu(String),
    Shell(String),
    Desktop(String),
    Open(String),
    Copy(String),
    CopyImage(String),
    Window { operation: String, target: String },
    Builtin(String),
    Extension { extension: String, command: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub icon: String,
    #[serde(default)]
    pub icon_font: String,
    pub keywords: String,
    pub action: Action,
}

impl Entry {
    pub fn new(id: &str, title: &str, subtitle: &str, icon: &str, action: Action) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            subtitle: subtitle.into(),
            icon: icon.into(),
            keywords: String::new(),
            icon_font: String::new(),
            action,
        }
    }

    pub fn can_hide(&self) -> bool {
        !matches!(&self.action, Action::Builtin(name) if name.starts_with("unhide:"))
    }

    pub fn hidden_key(&self) -> String {
        match &self.action {
            Action::Extension { extension, command } => format!("extension:{extension}:{command}"),
            Action::Shell(command)
                if self.id.contains(".provider.") || self.id.starts_with("mode-item:") =>
            {
                use sha2::{Digest, Sha256};
                let hash: String = Sha256::digest(command.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                format!("provider:{hash}")
            }
            _ => self.id.clone(),
        }
    }
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("HOME must be set"))
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
        .join("super-space")
}

pub fn data_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"))
        .join("super-space")
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/state"))
        .join("super-space")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub placeholder: String,
    pub search_url: String,
    pub font: String,
    pub width: f32,
    pub height: f32,
    pub position: String,
    pub follow_mouse: bool,
    pub show_icons: bool,
    pub show_scrollbar: bool,
    pub theme: String,
    pub background: String,
    pub foreground: String,
    pub accent: String,
    pub selection: String,
    pub max_results: usize,
    pub search_dirs: Vec<String>,
    pub aliases: HashMap<String, String>,
    pub shells: Vec<ShellCommand>,
    pub modes: HashMap<String, String>,
    pub blacklist: Vec<String>,
    pub hidden_actions: Vec<HiddenAction>,
    pub clipboard_paste_on_select: bool,
    pub clear_on_hide: bool,
    pub clear_on_enter: bool,
    pub debounce_ms: u64,
    pub toggle_hotkey: String,
    pub clipboard_hotkey: String,
    pub emoji_hotkey: String,
    pub start_at_login: bool,
    pub check_updates: bool,
    pub ai: AiConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HiddenAction {
    pub key: String,
    pub title: String,
    pub icon: String,
    #[serde(default)]
    pub icon_font: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub endpoint: String,
    pub model: String,
    pub models: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShellCommand {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    pub alias: Option<String>,
    pub hotkey: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            placeholder: "Search apps, commands, and extensions…".into(),
            search_url: "https://duckduckgo.com/?q=%s".into(),
            font: "Adwaita Sans".into(),
            width: 760.0,
            height: 530.0,
            position: "center".into(),
            follow_mouse: true,
            show_icons: true,
            show_scrollbar: true,
            theme: "dark".into(),
            background: String::new(),
            foreground: String::new(),
            accent: String::new(),
            selection: String::new(),
            max_results: 80,
            search_dirs: vec![
                "~/Documents".into(),
                "~/Downloads".into(),
                "~/Developer".into(),
                "~/Projects".into(),
            ],
            aliases: HashMap::new(),
            shells: vec![],
            modes: HashMap::new(),
            blacklist: vec![],
            hidden_actions: vec![],
            clipboard_paste_on_select: false,
            clear_on_hide: true,
            clear_on_enter: true,
            debounce_ms: 120,
            toggle_hotkey: "SUPER + SPACE".into(),
            clipboard_hotkey: "SUPER + CTRL + V".into(),
            emoji_hotkey: "SUPER + CTRL + E".into(),
            start_at_login: true,
            check_updates: true,
            ai: AiConfig::default(),
        }
    }
}

impl Config {
    pub fn is_hidden(&self, entry: &Entry) -> bool {
        if self.blacklist.is_empty() || !entry.can_hide() {
            return false;
        }
        let hidden_key = entry.hidden_key();
        self.blacklist.iter().any(|key| {
            key == &entry.id || key == &hidden_key || key.eq_ignore_ascii_case(&entry.title)
        })
    }

    pub fn hide_entry(&mut self, entry: &Entry) -> Result<(), String> {
        self.hide_entry_at(entry, &config_dir().join("config.toml"))
    }

    pub fn unhide_entry(&mut self, key: &str) -> Result<(), String> {
        self.unhide_entry_at(key, &config_dir().join("config.toml"))
    }

    fn hide_entry_at(&mut self, entry: &Entry, path: &std::path::Path) -> Result<(), String> {
        if !entry.can_hide() {
            return Err("Restore actions cannot be hidden".into());
        }
        let mut next = self.latest_at(path)?;
        let key = entry.hidden_key();
        if !next.blacklist.contains(&key) {
            next.blacklist.push(key.clone());
        }
        next.hidden_actions.retain(|hidden| hidden.key != key);
        next.hidden_actions.push(HiddenAction {
            key,
            title: entry.title.clone(),
            icon: entry.icon.clone(),
            icon_font: entry.icon_font.clone(),
        });
        next.save_at(path)?;
        *self = next;
        Ok(())
    }

    fn unhide_entry_at(&mut self, key: &str, path: &std::path::Path) -> Result<(), String> {
        let mut next = self.latest_at(path)?;
        next.blacklist.retain(|hidden| hidden != key);
        next.hidden_actions.retain(|hidden| hidden.key != key);
        next.save_at(path)?;
        *self = next;
        Ok(())
    }

    fn latest_at(&self, path: &std::path::Path) -> Result<Self, String> {
        if path.exists() {
            toml::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        } else {
            Ok(self.clone())
        }
    }

    pub fn load() -> Result<Self, String> {
        let path = config_dir().join("config.toml");
        if !path.exists() {
            let config = Self::default();
            config.save()?;
            return Ok(config);
        }
        let mut config: Self =
            toml::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        config.width = config.width.clamp(480.0, 1600.0);
        config.height = config.height.clamp(240.0, 1200.0);
        config.debounce_ms = config.debounce_ms.min(2000);
        config.max_results = config.max_results.clamp(10, 500);
        Ok(config)
    }

    pub fn save(&self) -> Result<(), String> {
        self.save_at(&config_dir().join("config.toml"))
    }

    fn save_at(&self, path: &std::path::Path) -> Result<(), String> {
        use std::io::Write;
        let directory = path.parent().ok_or("Configuration path has no parent")?;
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        use std::os::unix::fs::OpenOptionsExt;
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temporary = directory.join(format!(
            ".config.{}.{stamp}.{sequence}.tmp",
            std::process::id()
        ));
        let contents = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            file.write_all(contents.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            fs::rename(&temporary, path).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hiding_dynamic_entries_preserves_display_metadata_across_restart_and_restore() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        let entry = Entry::new(
            "file:/tmp/Quarterly Report.pdf",
            "Quarterly Report.pdf",
            "/tmp",
            "icon:Document",
            Action::Open("/tmp/Quarterly Report.pdf".into()),
        );
        let mut config = Config::default();
        config.hide_entry_at(&entry, &path).unwrap();
        let mut reopened: Config = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(reopened.is_hidden(&entry));
        assert_eq!(reopened.hidden_actions[0].title, entry.title);
        assert_eq!(reopened.hidden_actions[0].icon, entry.icon);
        reopened.unhide_entry_at(&entry.id, &path).unwrap();
        let restored: Config = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(!restored.is_hidden(&entry));
        assert!(restored.hidden_actions.is_empty());
    }

    #[test]
    fn hide_failure_does_not_change_current_config_or_persist_a_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let invalid_parent = directory.path().join("not-a-directory");
        fs::write(&invalid_parent, "untouched").unwrap();
        let mut config = Config::default();
        let before = toml::to_string(&config).unwrap();
        let entry = Entry::new(
            "application:firefox",
            "Firefox",
            "",
            "",
            Action::Desktop("firefox.desktop".into()),
        );
        assert!(
            config
                .hide_entry_at(&entry, &invalid_parent.join("config.toml"))
                .is_err()
        );
        assert_eq!(toml::to_string(&config).unwrap(), before);
        assert_eq!(fs::read_to_string(invalid_parent).unwrap(), "untouched");
    }

    #[test]
    fn hiding_preserves_newer_settings_and_provider_identity_survives_reordering() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        let mut current = Config::default();
        let saved = Config {
            placeholder: "Updated elsewhere".into(),
            ..Config::default()
        };
        saved.save_at(&path).unwrap();
        let entry = Entry::new(
            "provider.example.provider.0",
            "Example",
            "",
            "",
            Action::Shell("open-example --name one".into()),
        );
        current.hide_entry_at(&entry, &path).unwrap();
        assert_eq!(current.placeholder, "Updated elsewhere");
        let reordered = Entry {
            id: "provider.example.provider.5".into(),
            ..entry.clone()
        };
        assert!(current.is_hidden(&reordered));
        let replacement = Entry {
            action: Action::Shell("open-example --name two".into()),
            title: "Other".into(),
            ..entry
        };
        assert!(!current.is_hidden(&replacement));
    }

    #[test]
    fn only_restore_rows_are_protected_from_hiding() {
        let mut config = Config::default();
        for name in [
            "settings",
            "hidden",
            "edit-config",
            "unhide:application:firefox",
        ] {
            let entry = Entry::new(
                &format!("builtin:{name}"),
                name,
                "",
                "",
                Action::Builtin(name.into()),
            );
            config.blacklist.push(entry.id.clone());
            if name.starts_with("unhide:") {
                assert!(!entry.can_hide());
                assert!(!config.is_hidden(&entry));
            } else {
                assert!(entry.can_hide());
                assert!(config.is_hidden(&entry));
            }
        }
    }
}
