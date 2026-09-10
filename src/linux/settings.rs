use super::{
    app::Message,
    appearance::Colors,
    model::{Config, ShellCommand},
};
use iced::{
    Alignment, Background, Border, Color, Element,
    Length::Fill,
    widget::{self, checkbox, column, container, pick_list, row, scrollable, text, text_input},
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
            "ai_endpoint" => config.ai.endpoint = value,
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

    fn ai_endpoint(&self) -> String {
        self.config.ai.endpoint.trim().trim_end_matches('/').into()
    }

    pub fn validated(&self) -> Result<Config, String> {
        let mut config = self.config.clone();
        config.ai.endpoint = self.ai_endpoint();
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

    pub fn save(&self, previous: &Config) -> Result<Config, String> {
        let installed = super::integration::installed();
        save_config(self.validated()?, previous, Config::save, |config| {
            if installed {
                super::integration::apply(config)
            } else {
                Ok(())
            }
        })
    }

    pub fn view(&self, colors: Colors) -> Element<'_, Message> {
        let mut tabs = row![].spacing(4);
        for title in ["General", "Appearance", "Commands", "Extensions", "About"] {
            let selected = self.tab == title;
            tabs = tabs.push(
                button(title, colors)
                    .style(move |_, status| tab_style(colors, selected, status))
                    .on_press(Message::Setting("tab".into(), title.into())),
            );
        }
        let c = &self.config;
        let mut body = column![].spacing(12);
        match self.tab.as_str() {
            "General" => {
                body = body
                    .push(section("Search", colors))
                    .push(input(
                        "Placeholder",
                        "placeholder",
                        &c.placeholder,
                        "Search…",
                        colors,
                    ))
                    .push(input(
                        "Search URL",
                        "search_url",
                        &c.search_url,
                        "https://…?q=%s",
                        colors,
                    ))
                    .push(input(
                        "Folders",
                        "search_dirs",
                        &self.values["search_dirs"],
                        "~/Documents, ~/Downloads",
                        colors,
                    ))
                    .push(input(
                        "Hidden results",
                        "blacklist",
                        &self.values["blacklist"],
                        "Apps or commands, comma separated",
                        colors,
                    ))
                    .push(input(
                        "Result limit",
                        "max_results",
                        &self.values["max_results"],
                        "100",
                        colors,
                    ))
                    .push(input(
                        "Search delay (ms)",
                        "debounce_ms",
                        &self.values["debounce_ms"],
                        "Milliseconds",
                        colors,
                    ))
                    .push(section("Keyboard shortcuts", colors))
                    .push(input(
                        "Launcher",
                        "toggle_hotkey",
                        &c.toggle_hotkey,
                        "SUPER SPACE",
                        colors,
                    ))
                    .push(input(
                        "Clipboard",
                        "clipboard_hotkey",
                        &c.clipboard_hotkey,
                        "SUPER CTRL V",
                        colors,
                    ))
                    .push(input(
                        "Emoji",
                        "emoji_hotkey",
                        &c.emoji_hotkey,
                        "SUPER CTRL E",
                        colors,
                    ))
                    .push(section("Behavior", colors))
                    .push(toggle(
                        "Paste clipboard items into the previous app",
                        "clipboard_paste_on_select",
                        c.clipboard_paste_on_select,
                        colors,
                    ))
                    .push(toggle(
                        "Clear search when hiding",
                        "clear_on_hide",
                        c.clear_on_hide,
                        colors,
                    ))
                    .push(toggle(
                        "Clear search after running a command",
                        "clear_on_enter",
                        c.clear_on_enter,
                        colors,
                    ))
                    .push(toggle(
                        "Launch at login",
                        "start_at_login",
                        c.start_at_login,
                        colors,
                    ));
            }
            "Appearance" => {
                body = body
                    .push(section("Window", colors))
                    .push(choice(
                        "Theme",
                        "theme",
                        &c.theme,
                        &["omarchy", "dark", "light"],
                        colors,
                    ))
                    .push(choice(
                        "Position",
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
                        colors,
                    ))
                    .push(setting_row(
                        "Size",
                        row![
                            field("width", &self.values["width"], "Width", colors),
                            text("×").size(14).color(colors.muted),
                            field("height", &self.values["height"], "Height", colors),
                            text("px").size(12).color(colors.muted)
                        ]
                        .spacing(8)
                        .align_y(Alignment::Center),
                        colors,
                    ))
                    .push(input("Font", "font", &c.font, "Adwaita Sans", colors))
                    .push(toggle(
                        "Follow the pointer to its monitor",
                        "follow_mouse",
                        c.follow_mouse,
                        colors,
                    ))
                    .push(toggle("Show icons", "show_icons", c.show_icons, colors))
                    .push(toggle(
                        "Show scrollbar",
                        "show_scrollbar",
                        c.show_scrollbar,
                        colors,
                    ))
                    .push(section("Colors", colors))
                    .push(input(
                        "Background",
                        "background",
                        &c.background,
                        "Theme default",
                        colors,
                    ))
                    .push(input(
                        "Text",
                        "foreground",
                        &c.foreground,
                        "Theme default",
                        colors,
                    ))
                    .push(input(
                        "Accent",
                        "accent",
                        &c.accent,
                        "Theme default",
                        colors,
                    ))
                    .push(input(
                        "Selection",
                        "selection",
                        &c.selection,
                        "Theme default",
                        colors,
                    ));
            }
            "Extensions" => {
                let endpoint = self.ai_endpoint();
                body = body
                    .push(section("AI provider", colors))
                    .push(
                        text("Connect an OpenAI-compatible service for extension AI features.")
                            .size(13)
                            .color(colors.muted),
                    )
                    .push(input(
                        "API URL",
                        "ai_endpoint",
                        &c.ai.endpoint,
                        "https://api.openai.com/v1",
                        colors,
                    ))
                    .push(input(
                        "Model",
                        "ai_model",
                        &c.ai.model,
                        "Model identifier",
                        colors,
                    ))
                    .push(setting_row(
                        "API key",
                        row![
                            button("Set key…", colors)
                                .on_press(Message::AiKey(endpoint.clone(), false)),
                            remove_button(
                                "Remove saved API key",
                                Message::AiKey(endpoint, true),
                                colors
                            )
                        ]
                        .spacing(8),
                        colors,
                    ))
                    .push(
                        text("Stored in your desktop keyring. Optional for local providers.")
                            .size(12)
                            .color(colors.muted),
                    );
            }
            "Commands" => {
                body = body.push(section("Shell commands", colors));
                for (index, shell) in c.shells.iter().enumerate() {
                    let command = column![
                        row![
                            field(&format!("shell:{index}:name"), &shell.name, "Name", colors),
                            remove_button(
                                "Remove command",
                                Message::Setting(format!("shell:{index}:remove"), String::new()),
                                colors
                            )
                        ]
                        .spacing(8)
                        .align_y(Alignment::Center),
                        field(
                            &format!("shell:{index}:command"),
                            &shell.command,
                            "Command · use $1, $2 for arguments",
                            colors
                        ),
                        field(
                            &format!("shell:{index}:description"),
                            &shell.description,
                            "Description",
                            colors
                        ),
                        row![
                            field(
                                &format!("shell:{index}:alias"),
                                shell.alias.as_deref().unwrap_or(""),
                                "Alias",
                                colors
                            ),
                            field(
                                &format!("shell:{index}:hotkey"),
                                shell.hotkey.as_deref().unwrap_or(""),
                                "Shortcut",
                                colors
                            )
                        ]
                        .spacing(8)
                    ]
                    .spacing(8);
                    body = body.push(
                        container(command)
                            .padding(12)
                            .style(move |_| card_style(colors)),
                    );
                }
                body = body
                    .push(
                        button("+ Add command", colors)
                            .on_press(Message::Setting("add-shell".into(), String::new())),
                    )
                    .push(section("Search aliases", colors));
                for (index, (name, value)) in self.aliases.iter().enumerate() {
                    body = body.push(
                        row![
                            field(&format!("alias:{index}:name"), name, "Alias", colors),
                            field(
                                &format!("alias:{index}:value"),
                                value,
                                "Expanded search",
                                colors
                            ),
                            remove_button(
                                "Remove alias",
                                Message::Setting(format!("alias:{index}:remove"), String::new()),
                                colors
                            )
                        ]
                        .spacing(8)
                        .align_y(Alignment::Center),
                    );
                }
                body = body
                    .push(
                        button("+ Add alias", colors)
                            .on_press(Message::Setting("add-alias".into(), String::new())),
                    )
                    .push(section("Custom modes", colors));
                for (index, (name, value)) in self.modes.iter().enumerate() {
                    body = body.push(
                        row![
                            field(&format!("mode:{index}:name"), name, "Name", colors),
                            field(&format!("mode:{index}:value"), value, "Script path", colors),
                            remove_button(
                                "Remove mode",
                                Message::Setting(format!("mode:{index}:remove"), String::new()),
                                colors
                            )
                        ]
                        .spacing(8)
                        .align_y(Alignment::Center),
                    );
                }
                body = body
                    .push(
                        button("+ Add mode", colors)
                            .on_press(Message::Setting("add-mode".into(), String::new())),
                    )
                    .push(
                        text(
                            "Mode scripts return a title and command per line, separated by a tab.",
                        )
                        .size(12)
                        .color(colors.muted),
                    );
            }
            _ => {
                body = body
                    .push(
                        row![
                            text("Command Space").size(24),
                            text(env!("CARGO_PKG_VERSION")).size(13).color(colors.muted)
                        ]
                        .spacing(12)
                        .align_y(Alignment::Center),
                    )
                    .push(
                        text("A native launcher for Omarchy.")
                            .size(14)
                            .color(colors.muted),
                    )
                    .push(section("Updates", colors))
                    .push(toggle(
                        "Check for updates daily",
                        "check_updates",
                        c.check_updates,
                        colors,
                    ))
                    .push(button("Check for updates", colors).on_press(Message::Run(
                        super::model::Action::Builtin("updates".into()),
                    )))
                    .push(section("Project", colors))
                    .push(
                        row![
                            button("Source code ↗", colors).on_press(Message::Url(
                                "https://github.com/Aayush9029/command-space".into()
                            )),
                            button("RustCast ↗", colors).on_press(Message::Url(
                                "https://github.com/MystikoLab/rustcast".into()
                            ))
                        ]
                        .spacing(8),
                    )
                    .push(
                        text("Based on RustCast. Distributed under the MIT license.")
                            .size(12)
                            .color(colors.muted),
                    )
                    .push(button("Open configuration", colors).on_press(Message::Run(
                        super::model::Action::Builtin("edit-config".into()),
                    )));
            }
        }
        column![
            tabs.padding([8, 16]),
            divider(colors),
            scrollable(body.padding([20, 24]))
                .id("settings-body")
                .direction(scrollable::Direction::Vertical(
                    scrollable::Scrollbar::new().width(3).scroller_width(3)
                ))
                .height(Fill),
            divider(colors),
            row![
                widget::Space::new().width(Fill),
                button("Cancel", colors).on_press(Message::CancelSettings),
                button("Save", colors)
                    .style(move |_, status| primary_style(colors, status))
                    .on_press(Message::SaveSettings)
            ]
            .spacing(8)
            .padding([10, 16])
            .align_y(Alignment::Center)
        ]
        .spacing(0)
        .height(Fill)
        .into()
    }
}

fn save_config(
    config: Config,
    previous: &Config,
    mut persist: impl FnMut(&Config) -> Result<(), String>,
    mut apply: impl FnMut(&Config) -> Result<(), String>,
) -> Result<Config, String> {
    persist(&config)?;
    if let Err(error) = apply(&config) {
        let mut failures = Vec::new();
        if let Err(error) = persist(previous) {
            failures.push(format!("Could not restore configuration: {error}"));
        }
        if let Err(error) = apply(previous) {
            failures.push(format!("Could not restore desktop integration: {error}"));
        }
        return Err(if failures.is_empty() {
            format!("Settings could not be applied: {error}. Previous settings restored.")
        } else {
            format!(
                "Settings could not be applied: {error}. {}",
                failures.join(". ")
            )
        });
    }
    Ok(config)
}

fn border_color(colors: Colors) -> Color {
    Color {
        r: colors.background.r * 0.87 + colors.foreground.r * 0.13,
        g: colors.background.g * 0.87 + colors.foreground.g * 0.13,
        b: colors.background.b * 0.87 + colors.foreground.b * 0.13,
        a: 1.,
    }
}

fn divider<'a>(colors: Colors) -> Element<'a, Message> {
    container(widget::Space::new().height(1))
        .width(Fill)
        .style(move |_| container::Style {
            background: Some(border_color(colors).into()),
            ..Default::default()
        })
        .into()
}

fn section<'a>(title: &'a str, colors: Colors) -> Element<'a, Message> {
    container(text(title).size(12).color(colors.muted))
        .padding(iced::Padding {
            top: 8.,
            bottom: 2.,
            ..Default::default()
        })
        .into()
}

fn setting_row<'a>(
    title: &str,
    content: impl Into<Element<'a, Message>>,
    colors: Colors,
) -> Element<'a, Message> {
    row![
        text(title.to_owned())
            .size(13)
            .width(150)
            .color(colors.foreground),
        container(content).width(Fill)
    ]
    .spacing(16)
    .align_y(Alignment::Center)
    .width(Fill)
    .into()
}

fn input<'a>(
    title: &str,
    key: &str,
    value: &str,
    placeholder: &str,
    colors: Colors,
) -> Element<'a, Message> {
    setting_row(title, field(key, value, placeholder, colors), colors)
}

fn field<'a>(key: &str, value: &str, placeholder: &str, colors: Colors) -> Element<'a, Message> {
    let key = key.to_string();
    text_input(placeholder, value)
        .id(widget::Id::from(format!("setting:{key}")))
        .on_input(move |value| Message::Setting(key.clone(), value))
        .padding([8, 10])
        .size(13)
        .style(move |_, status| text_input::Style {
            background: Background::Color(colors.background),
            border: Border {
                color: if matches!(status, text_input::Status::Focused { .. }) {
                    colors.accent
                } else {
                    border_color(colors)
                },
                width: 1.,
                radius: 2.into(),
            },
            icon: colors.muted,
            placeholder: colors.muted,
            value: colors.foreground,
            selection: colors.selection,
        })
        .into()
}

fn toggle<'a>(title: &str, key: &str, value: bool, colors: Colors) -> Element<'a, Message> {
    let key = key.to_string();
    let id = format!("setting:{key}");
    let target = key.clone();
    super::focusable::wrap(
        id,
        checkbox(value)
            .label(title.to_string())
            .size(16)
            .text_size(13)
            .spacing(10)
            .style(move |_, status| checkbox::Style {
                background: Background::Color(if value {
                    colors.foreground
                } else {
                    colors.background
                }),
                icon_color: colors.background,
                border: Border {
                    color: if matches!(status, checkbox::Status::Hovered { .. }) {
                        colors.muted
                    } else {
                        border_color(colors)
                    },
                    width: 1.,
                    radius: 2.into(),
                },
                text_color: Some(colors.foreground),
            })
            .on_toggle(move |value| Message::Setting(key.clone(), value.to_string())),
        move |key| {
            super::focusable::activates(key)
                .then(|| Message::Setting(target.clone(), (!value).to_string()))
        },
    )
}

#[derive(Clone, PartialEq, Eq)]
struct Choice(String);

impl std::fmt::Display for Choice {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let label = self.0.replace('-', " ");
        let mut characters = label.chars();
        if let Some(first) = characters.next() {
            write!(formatter, "{}{}", first.to_uppercase(), characters.as_str())
        } else {
            Ok(())
        }
    }
}

fn choice<'a>(
    title: &str,
    key: &str,
    value: &str,
    options: &[&str],
    colors: Colors,
) -> Element<'a, Message> {
    let target = key.to_string();
    let id = format!("setting:{key}");
    let key = target.clone();
    let selected = Choice(value.to_string());
    let values: Vec<_> = options
        .iter()
        .map(|value| Choice(value.to_string()))
        .collect();
    let content = pick_list(values.clone(), Some(selected.clone()), move |value| {
        Message::Setting(key.clone(), value.0)
    })
    .padding([8, 10])
    .text_size(13)
    .width(Fill)
    .style(move |_, status| pick_list::Style {
        text_color: colors.foreground,
        placeholder_color: colors.muted,
        handle_color: colors.muted,
        background: colors.background.into(),
        border: Border {
            color: if matches!(status, pick_list::Status::Opened { .. }) {
                colors.accent
            } else {
                border_color(colors)
            },
            width: 1.,
            radius: 2.into(),
        },
    })
    .menu_style(move |_| widget::overlay::menu::Style {
        background: colors.background.into(),
        border: Border {
            color: border_color(colors),
            width: 1.,
            radius: 2.into(),
        },
        text_color: colors.foreground,
        selected_text_color: colors.foreground,
        selected_background: colors.selection.into(),
        shadow: Default::default(),
    });
    setting_row(
        title,
        super::focusable::wrap(id, content, move |key| {
            use iced::keyboard::{Key, key::Named};
            let delta = match key {
                Key::Named(Named::ArrowDown | Named::ArrowRight) => 1,
                Key::Named(Named::ArrowUp | Named::ArrowLeft) => -1,
                _ => return None,
            };
            let index = values
                .iter()
                .position(|value| *value == selected)
                .unwrap_or(0);
            let next = (index as i32 + delta).rem_euclid(values.len() as i32) as usize;
            Some(Message::Setting(target.clone(), values[next].0.clone()))
        }),
        colors,
    )
}

fn card_style(colors: Colors) -> container::Style {
    container::Style {
        background: Some(colors.background.into()),
        border: Border {
            color: border_color(colors),
            width: 1.,
            radius: 2.into(),
        },
        ..Default::default()
    }
}

fn secondary_style(colors: Colors, status: widget::button::Status) -> widget::button::Style {
    let hover = matches!(
        status,
        widget::button::Status::Hovered | widget::button::Status::Pressed
    );
    widget::button::Style {
        background: Some(
            if hover {
                colors.selection
            } else {
                colors.background
            }
            .into(),
        ),
        text_color: colors.foreground,
        border: Border {
            color: border_color(colors),
            width: 1.,
            radius: 2.into(),
        },
        ..Default::default()
    }
}

fn tab_style(
    colors: Colors,
    selected: bool,
    status: widget::button::Status,
) -> widget::button::Style {
    let mut style = secondary_style(colors, status);
    style.border.width = 0.;
    if selected {
        style.background = Some(colors.selection.into());
    }
    style.text_color = if selected {
        colors.foreground
    } else {
        colors.muted
    };
    style
}

fn primary_style(colors: Colors, status: widget::button::Status) -> widget::button::Style {
    widget::button::Style {
        background: Some(
            if matches!(
                status,
                widget::button::Status::Hovered | widget::button::Status::Pressed
            ) {
                colors.muted
            } else {
                colors.foreground
            }
            .into(),
        ),
        text_color: colors.background,
        border: Border {
            radius: 2.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn remove_button<'a>(title: &'a str, message: Message, colors: Colors) -> Element<'a, Message> {
    widget::tooltip(
        button("×", colors).on_press(message),
        container(text(title).size(12))
            .padding([6, 8])
            .style(move |_| card_style(colors)),
        widget::tooltip::Position::Top,
    )
    .into()
}

fn button<'a>(title: &str, colors: Colors) -> AccessibleButton<'a> {
    AccessibleButton(
        widget::button(text(title.to_owned()).size(13))
            .padding([7, 12])
            .style(move |_, status| secondary_style(colors, status)),
    )
}

struct AccessibleButton<'a>(widget::Button<'a, Message>);

impl<'a> AccessibleButton<'a> {
    fn style(
        mut self,
        style: impl Fn(&iced::Theme, widget::button::Status) -> widget::button::Style + 'a,
    ) -> Self {
        self.0 = self.0.style(style);
        self
    }
    fn on_press(self, message: Message) -> Element<'a, Message> {
        let id = format!("settings-action:{message:?}");
        super::focusable::wrap(id, self.0.on_press(message.clone()), move |key| {
            super::focusable::activates(key).then(|| message.clone())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_integration_restores_configuration_and_desktop_settings() {
        use std::cell::RefCell;
        let previous = Config::default();
        let mut draft = previous.clone();
        draft.placeholder = "New search".into();
        let operations = RefCell::new(Vec::new());
        let error = save_config(
            draft,
            &previous,
            |config| {
                operations
                    .borrow_mut()
                    .push(("save", config.placeholder.clone()));
                Ok(())
            },
            |config| {
                operations
                    .borrow_mut()
                    .push(("apply", config.placeholder.clone()));
                if config.placeholder == "New search" {
                    Err("Hyprland reload failed".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(
            operations.into_inner(),
            [
                ("save", "New search".into()),
                ("apply", "New search".into()),
                ("save", previous.placeholder.clone()),
                ("apply", previous.placeholder),
            ]
        );
        assert!(error.contains("Hyprland reload failed"));
        assert!(error.contains("Previous settings restored"));
    }

    #[test]
    fn rollback_failures_preserve_each_error_and_attempt_both_restores() {
        let previous = Config::default();
        let mut draft = previous.clone();
        draft.placeholder = "New search".into();
        let error = save_config(
            draft,
            &previous,
            |config| {
                if config.placeholder == "New search" {
                    Ok(())
                } else {
                    Err("Read-only config".into())
                }
            },
            |config| {
                Err(if config.placeholder == "New search" {
                    "Apply failed"
                } else {
                    "Reload failed"
                }
                .into())
            },
        )
        .unwrap_err();
        for message in ["Apply failed", "Read-only config", "Reload failed"] {
            assert!(error.contains(message));
        }
        assert!(!error.contains("Previous settings restored"));
    }

    #[test]
    fn failed_configuration_write_does_not_change_desktop_integration() {
        let config = Config::default();
        let error = save_config(
            config.clone(),
            &config,
            |_| Err("Disk full".into()),
            |_| panic!("Integration must not run after a failed write"),
        )
        .unwrap_err();
        assert_eq!(error, "Disk full");
    }

    #[test]
    fn ai_key_endpoint_matches_saved_endpoint_without_mutating_the_draft() {
        let mut editor = Editor::new(&Config::default());
        let draft = "  http://localhost:1234/v1/  ";
        editor.change("ai_endpoint", draft.into());
        assert_eq!(editor.ai_endpoint(), "http://localhost:1234/v1");
        assert_eq!(
            editor.ai_endpoint(),
            editor.validated().unwrap().ai.endpoint
        );
        assert_eq!(editor.config.ai.endpoint, draft);
    }

    #[test]
    fn typing_endpoint_preserves_slashes_until_settings_are_saved() {
        let mut editor = Editor::new(&Config::default());
        for character in "http://127.0.0.1:54329/v1/".chars() {
            editor.change(
                "ai_endpoint",
                format!("{}{character}", editor.config.ai.endpoint),
            );
        }
        assert_eq!(editor.config.ai.endpoint, "http://127.0.0.1:54329/v1/");
        assert_eq!(
            editor.validated().unwrap().ai.endpoint,
            "http://127.0.0.1:54329/v1"
        );
    }
}
