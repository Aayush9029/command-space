use super::model::{Config, home};
use iced::{
    Background, Border, Color, Theme,
    widget::{button, container, text_input},
};

#[derive(Clone, Copy, Debug)]
pub struct Colors {
    pub background: Color,
    pub foreground: Color,
    pub accent: Color,
    pub selection: Color,
    pub muted: Color,
}

impl Colors {
    pub fn configured(config: &Config) -> Self {
        let mut colors = Self::load();
        if config.theme == "light" {
            colors.background = Color::from_rgb8(245, 246, 248);
            colors.foreground = Color::from_rgb8(37, 42, 52);
            colors.selection = Color::from_rgb8(221, 230, 244);
            colors.accent = Color::from_rgb8(44, 85, 150);
            colors.muted = Color::from_rgb8(104, 114, 129);
        } else if config.theme == "dark" {
            colors.background = Color::from_rgb8(23, 23, 23);
            colors.foreground = Color::from_rgb8(238, 238, 238);
            colors.selection = Color::from_rgb8(42, 42, 42);
            colors.muted = Color::from_rgb8(160, 160, 160);
        }
        for (value, target) in [
            (&config.background, &mut colors.background),
            (&config.foreground, &mut colors.foreground),
            (&config.accent, &mut colors.accent),
            (&config.selection, &mut colors.selection),
        ] {
            if let Ok(color) = value.parse() {
                *target = color;
            }
        }
        colors
    }
    pub fn load() -> Self {
        let theme = home().join(".local/state/omarchy/current/theme/colors.toml");
        let value: toml::Value = std::fs::read_to_string(theme)
            .ok()
            .and_then(|raw| toml::from_str(&raw).ok())
            .unwrap_or(toml::Value::Table(Default::default()));
        let color = |key: &str, fallback: &str| {
            value
                .get(key)
                .and_then(toml::Value::as_str)
                .unwrap_or(fallback)
                .parse::<Color>()
                .unwrap_or(Color::BLACK)
        };
        Self {
            background: color("background", "#1a1b26"),
            foreground: color("foreground", "#a9b1d6"),
            accent: color("accent", "#7aa2f7"),
            selection: color("selection", "#292e42"),
            muted: color("dark_foreground", "#565f89"),
        }
    }

    pub fn theme(&self) -> Theme {
        Theme::custom(
            "Omarchy",
            iced::theme::Palette {
                background: self.background,
                text: self.foreground,
                primary: self.accent,
                success: Color::from_rgb8(158, 206, 106),
                warning: Color::from_rgb8(224, 175, 104),
                danger: Color::from_rgb8(247, 118, 142),
            },
        )
    }

    pub fn panel(&self) -> container::Style {
        container::Style {
            background: Some(Background::Color(self.background)),
            text_color: Some(self.foreground),
            border: Border {
                color: self.border(),
                width: 1.0,
                radius: 0.0.into(),
            },
            ..Default::default()
        }
    }

    pub fn row(&self, selected: bool, status: button::Status) -> button::Style {
        let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(Background::Color(if selected || hover {
                self.selection
            } else {
                self.background
            })),
            text_color: self.foreground,
            border: Border {
                radius: 3.0.into(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn input(&self) -> text_input::Style {
        text_input::Style {
            background: Background::Color(self.background),
            border: Border::default(),
            icon: self.accent,
            placeholder: self.muted,
            value: self.foreground,
            selection: self.selection,
        }
    }

    pub fn border(&self) -> Color {
        Color::from_rgb(
            self.background.r * 0.85 + self.foreground.r * 0.15,
            self.background.g * 0.85 + self.foreground.g * 0.15,
            self.background.b * 0.85 + self.foreground.b * 0.15,
        )
    }

    pub fn divider(&self) -> iced::widget::rule::Style {
        iced::widget::rule::Style {
            color: self.border(),
            radius: 0.into(),
            fill_mode: iced::widget::rule::FillMode::Full,
            snap: true,
        }
    }
}
