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
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("HOME must be set"))
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
        .join("command-space")
}

pub fn data_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"))
        .join("command-space")
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/state"))
        .join("command-space")
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
        fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
        let temporary = config_dir().join(format!("config.{}.tmp", std::process::id()));
        fs::write(
            &temporary,
            toml::to_string_pretty(self).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, config_dir().join("config.toml")).map_err(|e| e.to_string())
    }
}

pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}
