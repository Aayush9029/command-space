use super::{app::Message, appearance::Colors};
use iced::{Color, ContentFit, Element, widget};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

pub fn color(value: &Value, colors: Colors) -> Option<Color> {
    let value = value.as_str().or_else(|| {
        value[if colors.background.r + colors.background.g + colors.background.b > 1.5 {
            "light"
        } else {
            "dark"
        }]
        .as_str()
    })?;
    Some(match value.to_lowercase().as_str() {
        "red" => Color::from_rgb8(247, 118, 142),
        "green" => Color::from_rgb8(158, 206, 106),
        "blue" => Color::from_rgb8(122, 162, 247),
        "yellow" => Color::from_rgb8(224, 175, 104),
        "orange" => Color::from_rgb8(255, 158, 100),
        "purple" | "magenta" => Color::from_rgb8(187, 154, 247),
        "primarytext" => colors.foreground,
        "secondarytext" => colors.muted,
        custom => custom.parse().ok()?,
    })
}

fn tinted(source: &str, tint: Color) -> Option<widget::image::Handle> {
    static CACHE: OnceLock<Mutex<HashMap<String, widget::image::Handle>>> = OnceLock::new();
    let metadata = std::fs::metadata(source).ok()?;
    if metadata.len() > 16 * 1024 * 1024 {
        return None;
    }
    let key = format!("{source}/{:?}/{tint:?}", metadata.modified().ok());
    let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
    if let Some(handle) = cache.get(&key) {
        return Some(handle.clone());
    }
    let mut reader = image::ImageReader::open(source)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut image = reader.decode().ok()?.thumbnail(512, 512).to_rgba8();
    let rgba = tint.into_rgba8();
    for pixel in image.pixels_mut() {
        pixel.0 = [
            rgba[0],
            rgba[1],
            rgba[2],
            ((u16::from(pixel[3]) * u16::from(rgba[3])) / 255) as u8,
        ];
    }
    let handle = widget::image::Handle::from_rgba(image.width(), image.height(), image.into_raw());
    if cache.len() >= 128 {
        cache.clear();
    }
    cache.insert(key, handle.clone());
    Some(handle)
}

pub fn view<'a>(
    value: &'a Value,
    width: f32,
    height: f32,
    fit: ContentFit,
    colors: Colors,
) -> Element<'a, Message> {
    let source = value
        .as_str()
        .or_else(|| value["source"].as_str())
        .unwrap_or("");
    let tint = color(&value["tintColor"], colors);
    if source.starts_with('/') && std::path::Path::new(source).is_file() {
        if source.ends_with(".svg") {
            return widget::svg(widget::svg::Handle::from_path(source))
                .width(width)
                .height(height)
                .content_fit(fit)
                .style(move |_, _| widget::svg::Style { color: tint })
                .into();
        }
        let handle = tint
            .and_then(|color| tinted(source, color))
            .unwrap_or_else(|| widget::image::Handle::from_path(source));
        let radius = match value["mask"].as_str().unwrap_or("") {
            "circle" => width.min(height) / 2.,
            "roundedRectangle" => width.min(height) * 0.2,
            _ => 0.,
        };
        return widget::image(handle)
            .width(width)
            .height(height)
            .content_fit(fit)
            .border_radius(radius)
            .into();
    }
    if source.chars().count() > 8 && !value["fallback"].is_null() {
        return view(&value["fallback"], width, height, fit, colors);
    }
    let symbol = if !source.is_empty() && source.chars().count() <= 8 {
        source
    } else if value["fileIcon"]
        .as_str()
        .is_some_and(|path| std::path::Path::new(path).is_dir())
    {
        "󰉋"
    } else {
        "󰈔"
    };
    widget::container(
        widget::text(symbol)
            .size(height * 0.7)
            .color(tint.unwrap_or(colors.foreground)),
    )
    .center_x(width)
    .center_y(height)
    .into()
}
