use super::{
    app::Message,
    appearance::Colors,
    model::{Config, ShellCommand},
};
use iced::{
    Element,
    Length::Fill,
    widget::{button, checkbox, column, pick_list, row, scrollable, text, text_input},
};
use std::collections::HashMap;

pub struct Editor {
    pub config: Config,
    pub tab: String,
    values: HashMap<String, String>,
    aliases: Vec<(String, String)>,
    modes: Vec<(String, String)>,
}

impl Editor {
    pub fn new(config: &Config) -> Self {
        let values = [
            ("width", config.width.to_string()),
            ("height", config.height.to_string()),
            ("max_results", config.max_results.to_string()),
            ("debounce_ms", config.debounce_ms.to_string()),
            ("search_dirs", config.search_dirs.join(", ")),
            ("blacklist", config.blacklist.join(", ")),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect();
        let mut aliases = config
            .aliases
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect::<Vec<_>>();
        aliases.sort();
        let mut modes = config
            .modes
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect::<Vec<_>>();
        modes.sort();
        Self {
            config: config.clone(),
            tab: "General".into(),
            values,
            aliases,
            modes,
        }
    }

    pub fn change(&mut self, key: &str, value: String) {
        let config = &mut self.config;
        match key {
            "tab" => self.tab = value,
            "placeholder" => config.placeholder = value,
            "search_url" => config.search_url = value,
            "font" => config.font = value,
            "position" => config.position = value,
            "theme" => config.theme = value,
            "ai_endpoint" => config.ai.endpoint = value.trim().trim_end_matches('/').into(),
            "ai_model" => config.ai.model = value,
            "background" => config.background = value,
            "foreground" => config.foreground = value,
            "accent" => config.accent = value,
            "selection" => config.selection = value,
            "toggle_hotkey" => config.toggle_hotkey = value,
            "clipboard_hotkey" => config.clipboard_hotkey = value,
            "emoji_hotkey" => config.emoji_hotkey = value,
            "follow_mouse" => config.follow_mouse = value == "true",
            "show_icons" => config.show_icons = value == "true",
            "show_scrollbar" => config.show_scrollbar = value == "true",
            "clear_on_hide" => config.clear_on_hide = value == "true",
            "clear_on_enter" => config.clear_on_enter = value == "true",
            "clipboard_paste_on_select" => config.clipboard_paste_on_select = value == "true",
            "start_at_login" => config.start_at_login = value == "true",
            "check_updates" => config.check_updates = value == "true",
            "add-shell" => config.shells.push(ShellCommand {
                name: String::new(),
                command: String::new(),
                description: String::new(),
                icon: "".into(),
                alias: None,
                hotkey: None,
            }),
            "add-alias" => self.aliases.push(Default::default()),
            "add-mode" => self.modes.push(Default::default()),
            _ if key.starts_with("shell:") => {
                let parts = key.split(':').collect::<Vec<_>>();
                if let Some(index) = parts.get(1).and_then(|v| v.parse::<usize>().ok()) {
                    if parts.get(2) == Some(&"remove") {
                        if index < config.shells.len() {
                            config.shells.remove(index);
                        }
                    } else if let Some(shell) = config.shells.get_mut(index) {
                        match parts.get(2).copied().unwrap_or("") {
                            "name" => shell.name = value,
                            "command" => shell.command = value,
                            "description" => shell.description = value,
                            "icon" => shell.icon = value,
                            "alias" => shell.alias = (!value.is_empty()).then_some(value),
                            "hotkey" => shell.hotkey = (!value.is_empty()).then_some(value),
                            _ => {}
                        }
                    }
                }
            }
            _ if key.starts_with("alias:") || key.starts_with("mode:") => {
                let parts = key.split(':').collect::<Vec<_>>();
                let entries = if parts[0] == "alias" {
                    &mut self.aliases
                } else {
                    &mut self.modes
                };
                if let Some(index) = parts.get(1).and_then(|v| v.parse::<usize>().ok()) {
                    if parts.get(2) == Some(&"remove") {
                        if index < entries.len() {
                            entries.remove(index);
                        }
                    } else if let Some(entry) = entries.get_mut(index) {
                        if parts.get(2) == Some(&"name") {
                            entry.0 = value;
                        } else {
                            entry.1 = value;
                        }
                    }
                }
            }
            _ => {
                self.values.insert(key.into(), value);
            }
        }
    }

    pub fn validated(&self) -> Result<Config, String> {
        let mut config = self.config.clone();
        let number = |key: &str, min: f32, max: f32| -> Result<f32, String> {
            let value: f32 = self.values[key]
                .parse()
                .map_err(|_| format!("{key} must be a number"))?;
            if !value.is_finite() || !(min..=max).contains(&value) {
                return Err(format!("{key} must be between {min} and {max}"));
            }
            Ok(value)
        };
        config.width = number("width", 480.0, 1600.0)?;
        config.height = number("height", 240.0, 1200.0)?;
        config.max_results = number("max_results", 10.0, 500.0)? as usize;
        config.debounce_ms = number("debounce_ms", 0.0, 2000.0)? as u64;
        let list = |key: &str| {
            self.values[key]
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        };
        config.search_dirs = list("search_dirs");
        config.blacklist = list("blacklist");
        config.aliases = self
            .aliases
            .iter()
            .filter(|(a, _)| !a.is_empty())
            .cloned()
            .collect();
        config.modes = self
            .modes
            .iter()
            .filter(|(a, _)| !a.is_empty())
            .cloned()
            .collect();
        if config
            .shells
            .iter()
            .any(|s| s.name.trim().is_empty() || s.command.trim().is_empty())
        {
            return Err("Each shell command needs a name and command".into());
        }
        for color in [
            &config.background,
            &config.foreground,
            &config.accent,
            &config.selection,
        ] {
            if !color.is_empty() && color.parse::<iced::Color>().is_err() {
                return Err("Colors must use a hex value such as #1a1b26".into());
            }
        }
        if !config.search_url.contains("%s") {
            return Err("Search URL must contain %s for the search text".into());
        }
        if !config.ai.endpoint.is_empty()
            && url::Url::parse(&config.ai.endpoint).ok().is_none_or(|url| {
                !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
            })
        {
            return Err("The AI endpoint must be an HTTP or HTTPS URL".into());
        }
        super::integration::bindings(&config)?;
        Ok(config)
    }

    pub fn view(&self, colors: Colors) -> Element<'_, Message> {
        let mut tabs = row![].spacing(8);
        for title in ["General", "Appearance", "Commands", "Extensions", "About"] {
            let selected = self.tab == title;
            tabs = tabs.push(
                button(text(title).size(13))
                    .style(move |_, s| colors.row(selected, s))
                    .on_press(Message::Setting("tab".into(), title.into())),
            );
        }
        let c = &self.config;
        let mut body = column![].spacing(14);
        match self.tab.as_str() {
            "General" => {
                body = body
                    .push(input("Search placeholder", "placeholder", &c.placeholder))
                    .push(input(
                        "Search URL (%s is replaced with your search)",
                        "search_url",
                        &c.search_url,
                    ))
                    .push(input(
                        "Search folders, separated by commas",
                        "search_dirs",
                        &self.values["search_dirs"],
                    ))
                    .push(input(
                        "Hidden apps and commands, separated by commas",
                        "blacklist",
                        &self.values["blacklist"],
                    ))
                    .push(input(
                        "Maximum search results",
                        "max_results",
                        &self.values["max_results"],
                    ))
                    .push(input(
                        "File search delay in milliseconds",
                        "debounce_ms",
                        &self.values["debounce_ms"],
                    ))
                    .push(input(
                        "Launcher shortcut",
                        "toggle_hotkey",
                        &c.toggle_hotkey,
                    ))
                    .push(input(
                        "Clipboard shortcut",
                        "clipboard_hotkey",
                        &c.clipboard_hotkey,
                    ))
                    .push(input("Emoji shortcut", "emoji_hotkey", &c.emoji_hotkey))
                    .push(toggle(
                        "Paste clipboard items into the previous app",
                        "clipboard_paste_on_select",
                        c.clipboard_paste_on_select,
                    ))
                    .push(toggle(
                        "Clear search when hiding",
                        "clear_on_hide",
                        c.clear_on_hide,
                    ))
                    .push(toggle(
                        "Clear search after running a command",
                        "clear_on_enter",
                        c.clear_on_enter,
                    ))
                    .push(toggle(
                        "Start Command Space at login",
                        "start_at_login",
                        c.start_at_login,
                    ));
            }
            "Appearance" => {
                body = body
                    .push(choice(
                        "Theme",
                        "theme",
                        &c.theme,
                        &["omarchy", "dark", "light"],
                    ))
                    .push(choice(
                        "Window position",
                        "position",
                        &c.position,
                        &[
                            "center",
                            "top-left",
                            "top",
                            "top-right",
                            "left",
                            "right",
                            "bottom-left",
                            "bottom",
                            "bottom-right",
                        ],
                    ))
                    .push(input("Window width", "width", &self.values["width"]))
                    .push(input("Window height", "height", &self.values["height"]))
                    .push(input("Font (applied on next app start)", "font", &c.font))
                    .push(toggle(
                        "Open on the monitor with the pointer",
                        "follow_mouse",
                        c.follow_mouse,
                    ))
                    .push(toggle("Show icons", "show_icons", c.show_icons))
                    .push(toggle("Show scrollbar", "show_scrollbar", c.show_scrollbar))
                    .push(text("Color overrides · leave blank to follow the theme").size(13))
                    .push(input("Background", "background", &c.background))
                    .push(input("Text", "foreground", &c.foreground))
                    .push(input("Accent", "accent", &c.accent))
                    .push(input("Selected row", "selection", &c.selection));
            }
            "Extensions" => {
                body = body.push(text("AI provider").size(18))
                    .push(text("Extensions that use Raycast AI send their prompts to this provider. Local and hosted OpenAI-compatible endpoints are supported.").size(13))
                    .push(input("API base URL (including /v1)", "ai_endpoint", &c.ai.endpoint))
                    .push(input("Model identifier", "ai_model", &c.ai.model))
                    .push(button("Set API key…").on_press(Message::AiKey(c.ai.endpoint.clone(), false)))
                    .push(button("Remove saved API key").on_press(Message::AiKey(c.ai.endpoint.clone(), true)))
                    .push(text("Keys are stored in the desktop keyring. Leave the key unset for a local provider that does not require authentication. Save settings to apply the endpoint and model.").size(12));
            }
            "Commands" => {
                body = body.push(text("Shell commands").size(18))
                    .push(text("Use $1, $2, … for arguments. Invoke an alias followed by quoted arguments.").size(12));
                for (index, shell) in c.shells.iter().enumerate() {
                    body = body.push(
                        column![
                            input("Name", &format!("shell:{index}:name"), &shell.name),
                            input("Command", &format!("shell:{index}:command"), &shell.command),
                            input(
                                "Description",
                                &format!("shell:{index}:description"),
                                &shell.description
                            ),
                            input(
                                "Alias",
                                &format!("shell:{index}:alias"),
                                shell.alias.as_deref().unwrap_or("")
                            ),
                            input(
                                "Shortcut",
                                &format!("shell:{index}:hotkey"),
                                shell.hotkey.as_deref().unwrap_or("")
                            ),
                            button("Remove command").on_press(Message::Setting(
                                format!("shell:{index}:remove"),
                                String::new()
                            ))
                        ]
                        .spacing(8),
                    );
                }
                body = body
                    .push(
                        button("Add shell command")
                            .on_press(Message::Setting("add-shell".into(), String::new())),
                    )
                    .push(text("Search aliases").size(18));
                for (index, (name, value)) in self.aliases.iter().enumerate() {
                    body = body.push(
                        row![
                            input("Alias", &format!("alias:{index}:name"), name),
                            input("Expanded search", &format!("alias:{index}:value"), value),
                            button("Remove").on_press(Message::Setting(
                                format!("alias:{index}:remove"),
                                String::new()
                            ))
                        ]
                        .spacing(8),
                    );
                }
                body = body.push(button("Add alias").on_press(Message::Setting("add-alias".into(), String::new())))
                    .push(text("Custom modes").size(18)).push(text("A shell script prints one title and command per line, separated by a tab.").size(12));
                for (index, (name, value)) in self.modes.iter().enumerate() {
                    body = body.push(
                        row![
                            input("Name", &format!("mode:{index}:name"), name),
                            input("Script", &format!("mode:{index}:value"), value),
                            button("Remove").on_press(Message::Setting(
                                format!("mode:{index}:remove"),
                                String::new()
                            ))
                        ]
                        .spacing(8),
                    );
                }
                body = body.push(
                    button("Add mode").on_press(Message::Setting("add-mode".into(), String::new())),
                );
            }
            _ => {
                body = body.push(text(format!("Command Space {}", env!("CARGO_PKG_VERSION"))).size(24))
                    .push(toggle("Check for updates daily", "check_updates", c.check_updates))
                    .push(button("Check for updates").on_press(Message::Run(super::model::Action::Builtin("updates".into()))))
                    .push(text("Native launcher for Omarchy. Derived from RustCast and distributed under the MIT license.").size(14))
                    .push(button("Command Space on GitHub").on_press(Message::Url("https://github.com/Aayush9029/command-space".into())))
                    .push(button("RustCast upstream").on_press(Message::Url("https://github.com/MystikoLab/rustcast".into())))
                    .push(button("Open configuration file").on_press(Message::Run(super::model::Action::Builtin("edit-config".into()))));
            }
        }
        column![
            tabs,
            scrollable(body.padding([8, 4])).height(Fill),
            row![
                button("Save settings").on_press(Message::SaveSettings),
                button("Cancel").on_press(Message::CancelSettings)
            ]
            .spacing(12)
        ]
        .spacing(12)
        .padding(16)
        .into()
    }
}

fn input<'a>(title: &str, key: &str, value: &str) -> Element<'a, Message> {
    let key = key.to_string();
    column![
        text(title.to_string()).size(12),
        text_input("", value)
            .on_input(move |value| Message::Setting(key.clone(), value))
            .padding(8)
            .size(14)
    ]
    .spacing(5)
    .width(Fill)
    .into()
}

fn toggle<'a>(title: &str, key: &str, value: bool) -> Element<'a, Message> {
    let key = key.to_string();
    checkbox(value)
        .label(title.to_string())
        .on_toggle(move |value| Message::Setting(key.clone(), value.to_string()))
        .into()
}

fn choice<'a>(title: &str, key: &str, value: &str, options: &[&str]) -> Element<'a, Message> {
    let key = key.to_string();
    column![
        text(title.to_string()).size(12),
        pick_list(
            options.iter().map(|v| v.to_string()).collect::<Vec<_>>(),
            Some(value.to_string()),
            move |value| Message::Setting(key.clone(), value)
        )
    ]
    .spacing(5)
    .into()
}
