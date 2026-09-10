use iced::advanced::graphics::text::cosmic_text::{
    Align, Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache,
};
use image::{ImageEncoder, RgbaImage};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

const SIZE: u32 = 48;

#[derive(Clone)]
pub struct TrayImage {
    rgba: Vec<u8>,
}

impl TrayImage {
    pub fn pixmap(&self) -> Vec<ksni::Icon> {
        vec![ksni::Icon {
            width: SIZE as i32,
            height: SIZE as i32,
            data: self
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|p| [p[3], p[0], p[1], p[2]])
                .collect(),
        }]
    }

    pub fn png(&self) -> Vec<u8> {
        let mut bytes = vec![];
        if image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&self.rgba, SIZE, SIZE, image::ExtendedColorType::Rgba8)
            .is_err()
        {
            return vec![];
        }
        bytes
    }
}

struct Renderer {
    fonts: FontSystem,
    swash: SwashCache,
    images: HashMap<String, TrayImage>,
}

pub fn render(value: &Value) -> Option<TrayImage> {
    render_source(value).or_else(|| value.get("fallback").and_then(render))
}

fn render_source(value: &Value) -> Option<TrayImage> {
    let source = value.as_str().or_else(|| value["source"].as_str());
    let source = source
        .map(str::to_owned)
        .or_else(|| value["fileIcon"].as_str().map(super::icons::file_icon))?;
    let symbolic = source.starts_with("icon:") || source.ends_with("-symbolic.svg");
    let source = if source.starts_with("icon:") {
        super::icons::builtin(&source)?
    } else {
        source
    };
    if source.is_empty() {
        return None;
    }
    let colors = super::appearance::Colors::load();
    let tint = super::extension_image::color(&value["tintColor"], colors)
        .or_else(|| symbolic.then_some(colors.foreground));
    let color = tint.unwrap_or(colors.foreground);
    let modified = std::fs::metadata(&source)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    let key = format!("{value}/{source}/{color:?}/{modified:?}");
    static RENDERER: OnceLock<Mutex<Renderer>> = OnceLock::new();
    let mut renderer = RENDERER
        .get_or_init(|| {
            Mutex::new(Renderer {
                fonts: FontSystem::new(),
                swash: SwashCache::new(),
                images: HashMap::new(),
            })
        })
        .lock()
        .ok()?;
    if let Some(image) = renderer.images.get(&key) {
        return Some(image.clone());
    }
    let image = if source.starts_with('/') {
        if std::fs::metadata(&source).ok()?.len() > 16 * 1024 * 1024 {
            return None;
        }
        let mut image = super::extension_image::raster(&source)?;
        super::extension_image::apply_style(&mut image, tint, value["mask"].as_str().unwrap_or(""));
        let image = image::imageops::thumbnail(&image, SIZE, SIZE);
        let mut canvas = RgbaImage::new(SIZE, SIZE);
        image::imageops::overlay(
            &mut canvas,
            &image,
            ((SIZE - image.width()) / 2) as i64,
            ((SIZE - image.height()) / 2) as i64,
        );
        TrayImage {
            rgba: canvas.into_raw(),
        }
    } else {
        if !super::icons::is_symbol(&source) {
            return None;
        }
        let Renderer { fonts, swash, .. } = &mut *renderer;
        let mut buffer = Buffer::new(fonts, Metrics::new(40., 48.));
        buffer.set_size(fonts, Some(SIZE as f32), Some(SIZE as f32));
        buffer.set_text(
            fonts,
            &source,
            &Attrs::new().family(match super::icons::font("", &source).family {
                iced::font::Family::Name(name) => Family::Name(name),
                _ => Family::SansSerif,
            }),
            Shaping::Advanced,
            Some(Align::Center),
        );
        buffer.shape_until_scroll(fonts, true);
        let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
        buffer.draw(
            fonts,
            swash,
            Color::rgb(
                (color.r * 255.) as u8,
                (color.g * 255.) as u8,
                (color.b * 255.) as u8,
            ),
            |x, y, _, _, color| {
                if x >= 0 && y >= 0 && x < SIZE as i32 && y < SIZE as i32 {
                    let index = ((y as u32 * SIZE + x as u32) * 4) as usize;
                    rgba[index..index + 4].copy_from_slice(&color.as_rgba());
                }
            },
        );
        TrayImage { rgba }
    };
    if renderer.images.len() >= 128 {
        renderer.images.clear();
    }
    renderer.images.insert(key, image.clone());
    Some(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_tray_images_use_the_supplied_fallback() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("icon.svg");
        std::fs::write(&file, "invalid SVG").unwrap();
        let icon = render(&serde_json::json!({"source":file,"fallback":"icon:Heart"})).unwrap();
        assert!(
            image::load_from_memory(&icon.png())
                .unwrap()
                .to_rgba8()
                .pixels()
                .any(|pixel| pixel[3] > 0)
        );
    }

    #[test]
    fn svg_tray_icons_render_with_tint_and_masks() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("icon.svg");
        std::fs::write(&file, r#"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h32v32H0z"/></svg>"#).unwrap();
        let icon =
            render(&serde_json::json!({"source":file,"tintColor":"red","mask":"circle"})).unwrap();
        let pixels = image::load_from_memory(&icon.png()).unwrap().to_rgba8();
        assert_eq!(pixels.get_pixel(0, 0)[3], 0);
        assert_eq!(&pixels.get_pixel(24, 24).0[..3], &[247, 118, 142]);
    }

    #[test]
    fn png_tray_images_preserve_color_and_use_status_notifier_argb() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("icon.png");
        RgbaImage::from_pixel(48, 48, image::Rgba([20, 100, 200, 255]))
            .save(&file)
            .unwrap();
        let image = render(&serde_json::json!(file)).unwrap();
        assert_eq!(&image.pixmap()[0].data[..4], &[255, 20, 100, 200]);
        assert_eq!(
            image::load_from_memory(&image.png())
                .unwrap()
                .to_rgba8()
                .get_pixel(24, 24)
                .0,
            [20, 100, 200, 255]
        );
    }
}
