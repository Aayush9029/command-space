use super::{app::Message, appearance::Colors};
use iced::{Color, ContentFit, Element, widget};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
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

fn svg_options() -> resvg::usvg::Options<'static> {
    static FONTS: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    let fonts = FONTS.get_or_init(|| {
        let mut fonts = resvg::usvg::fontdb::Database::new();
        fonts.load_system_fonts();
        Arc::new(fonts)
    });
    resvg::usvg::Options {
        font_family: "Adwaita Sans".into(),
        fontdb: fonts.clone(),
        ..Default::default()
    }
}

pub(super) fn raster(source: &str) -> Option<image::RgbaImage> {
    if std::fs::metadata(source).ok()?.len() > 16 * 1024 * 1024 {
        return None;
    }
    if source.to_lowercase().ends_with(".svg") {
        let tree =
            resvg::usvg::Tree::from_data(&std::fs::read(source).ok()?, &svg_options()).ok()?;
        let scale = 256. / tree.size().width().max(tree.size().height());
        let mut pixmap = resvg::tiny_skia::Pixmap::new(
            (tree.size().width() * scale).ceil().max(1.) as u32,
            (tree.size().height() * scale).ceil().max(1.) as u32,
        )?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );
        let pixels = pixmap
            .pixels()
            .iter()
            .flat_map(|pixel| {
                let color = pixel.demultiply();
                [color.red(), color.green(), color.blue(), color.alpha()]
            })
            .collect();
        return image::RgbaImage::from_raw(pixmap.width(), pixmap.height(), pixels);
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
    Some(
        reader
            .decode()
            .ok()?
            .resize(256, 256, image::imageops::FilterType::CatmullRom)
            .to_rgba8(),
    )
}

pub(super) fn apply_style(image: &mut image::RgbaImage, tint: Option<Color>, mask: &str) {
    let (width, height) = (image.width() as f32, image.height() as f32);
    let radius = match mask {
        "circle" => width.min(height) / 2.,
        "roundedRectangle" => width.min(height) * 0.2,
        _ => 0.,
    };
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        if let Some(tint) = tint {
            let rgba = tint.into_rgba8();
            pixel.0 = [
                rgba[0],
                rgba[1],
                rgba[2],
                ((u16::from(pixel[3]) * u16::from(rgba[3])) / 255) as u8,
            ];
        }
        if radius > 0. {
            let x = (x as f32 + 0.5 - width / 2.).abs();
            let y = (y as f32 + 0.5 - height / 2.).abs();
            let distance = if mask == "circle" {
                x.hypot(y) - radius
            } else {
                let dx = x - (width / 2. - radius);
                let dy = y - (height / 2. - radius);
                dx.max(0.).hypot(dy.max(0.)) + dx.max(dy).min(0.) - radius
            };
            pixel[3] = (f32::from(pixel[3]) * (0.5 - distance).clamp(0., 1.)) as u8;
        }
    }
}

#[derive(Clone)]
enum FileImage {
    Svg(widget::svg::Handle),
    Raster(widget::image::Handle),
}

struct CachedFile {
    image: Option<FileImage>,
    bytes: usize,
    used: u64,
}

#[derive(Default)]
struct ImageCache {
    entries: HashMap<String, CachedFile>,
    bytes: usize,
    clock: u64,
}

impl ImageCache {
    fn load(&mut self, source: &str, tint: Option<Color>, mask: &str) -> Option<FileImage> {
        let metadata = std::fs::metadata(source).ok()?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
            return None;
        }
        let key = format!(
            "{source}/{:?}/{}/{tint:?}/{mask}",
            metadata.modified().ok(),
            metadata.len()
        );
        self.clock += 1;
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.used = self.clock;
            return entry.image.clone();
        }
        let loaded = if source.to_lowercase().ends_with(".svg") && mask.is_empty() {
            std::fs::read(source).ok().and_then(|bytes| {
                resvg::usvg::Tree::from_data(&bytes, &resvg::usvg::Options::default()).ok()?;
                let size = bytes.len();
                Some((
                    FileImage::Svg(widget::svg::Handle::from_memory(bytes)),
                    size,
                ))
            })
        } else {
            raster(source).map(|mut image| {
                apply_style(&mut image, tint, mask);
                let size = image.as_raw().len();
                (
                    FileImage::Raster(widget::image::Handle::from_rgba(
                        image.width(),
                        image.height(),
                        image.into_raw(),
                    )),
                    size,
                )
            })
        };
        let bytes = loaded.as_ref().map_or(0, |(_, bytes)| *bytes);
        while self.entries.len() >= 128 || self.bytes + bytes > 32 * 1024 * 1024 {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes -= entry.bytes;
            }
        }
        let image = loaded.map(|(image, _)| image);
        self.bytes += bytes;
        self.entries.insert(
            key,
            CachedFile {
                image: image.clone(),
                bytes,
                used: self.clock,
            },
        );
        image
    }
}

pub fn file<'a>(
    source: &str,
    width: f32,
    height: f32,
    fit: ContentFit,
    tint: Option<Color>,
    mask: &str,
) -> Option<Element<'a, Message>> {
    static CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();
    let image = CACHE
        .get_or_init(Default::default)
        .lock()
        .ok()?
        .load(source, tint, mask)?;
    Some(match image {
        FileImage::Svg(handle) => widget::svg(handle)
            .width(width)
            .height(height)
            .content_fit(fit)
            .style(move |_, _| widget::svg::Style { color: tint })
            .into(),
        FileImage::Raster(handle) => widget::image(handle)
            .width(width)
            .height(height)
            .content_fit(fit)
            .into(),
    })
}

pub fn view<'a>(
    value: &'a Value,
    width: f32,
    height: f32,
    fit: ContentFit,
    colors: Colors,
) -> Element<'a, Message> {
    if value.is_null() || value.as_str() == Some("") {
        return widget::Space::new().width(width).height(height).into();
    }
    let source = value
        .as_str()
        .or_else(|| value["source"].as_str())
        .unwrap_or("");
    let source = if source.is_empty() {
        value["fileIcon"]
            .as_str()
            .map(super::icons::file_icon)
            .unwrap_or_default()
    } else {
        source.to_owned()
    };
    let tint = color(&value["tintColor"], colors).or_else(|| {
        source
            .ends_with("-symbolic.svg")
            .then_some(colors.foreground)
    });
    if source.starts_with('/') {
        if let Some(image) = file(
            &source,
            width,
            height,
            fit,
            tint,
            value["mask"].as_str().unwrap_or(""),
        ) {
            return image;
        }
        if !value["fallback"].is_null() {
            return view(&value["fallback"], width, height, fit, colors);
        }
    }
    if !value["fallback"].is_null() && !super::icons::is_symbol(&source) {
        return view(&value["fallback"], width, height, fit, colors);
    }
    let symbol = if super::icons::is_symbol(&source) {
        source
    } else {
        "󰈔".into()
    };
    let font = super::icons::font("", &symbol);
    widget::container(
        widget::text(symbol)
            .size(height * 0.7)
            .font(font)
            .color(tint.unwrap_or(colors.foreground)),
    )
    .center_x(width)
    .center_y(height)
    .clip(true)
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_icon_formats_decode_with_the_first_gif_frame() {
        let folder = tempfile::tempdir().unwrap();
        let pixels = image::RgbaImage::from_pixel(16, 16, image::Rgba([220, 40, 80, 255]));
        for (extension, format) in [
            ("ico", image::ImageFormat::Ico),
            ("bmp", image::ImageFormat::Bmp),
        ] {
            let path = folder.path().join(format!("icon.{extension}"));
            pixels.save_with_format(&path, format).unwrap();
            let decoded = raster(path.to_str().unwrap()).unwrap();
            assert_eq!(decoded.get_pixel(8, 8).0, [220, 40, 80, 255], "{extension}");
        }
        let path = folder.path().join("animated.gif");
        {
            let mut encoder =
                image::codecs::gif::GifEncoder::new(std::fs::File::create(&path).unwrap());
            encoder.encode_frame(image::Frame::new(pixels)).unwrap();
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                    16,
                    16,
                    image::Rgba([10, 20, 200, 255]),
                )))
                .unwrap();
        }
        let decoded = raster(path.to_str().unwrap()).unwrap();
        assert_eq!(decoded.get_pixel(8, 8).0, [220, 40, 80, 255]);
        std::fs::write(&path, b"GIF89a malformed").unwrap();
        assert!(raster(path.to_str().unwrap()).is_none());
    }

    #[test]
    fn every_bundled_symbol_rasterizes_to_visible_pixels() {
        let catalog: Value =
            serde_json::from_str(include_str!("../../runtime/icons/catalog.json")).unwrap();
        let assets: std::collections::HashSet<_> = catalog["icons"]
            .as_object()
            .unwrap()
            .values()
            .map(|icon| icon["asset"].as_str().unwrap())
            .collect();
        for asset in assets {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/icons")
                .join(asset);
            let image = raster(path.to_str().unwrap())
                .unwrap_or_else(|| panic!("Could not rasterize {asset}"));
            assert!(
                image.pixels().any(|pixel| pixel[3] > 0),
                "Blank icon: {asset}"
            );
        }
    }

    #[test]
    fn local_image_cache_reuses_handles_and_reloads_changed_svg_bytes() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("icon.svg");
        std::fs::write(&path, r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>"#).unwrap();
        let mut cache = ImageCache::default();
        assert!(matches!(
            cache.load(path.to_str().unwrap(), None, ""),
            Some(FileImage::Svg(_))
        ));
        let bytes = cache.bytes;
        cache.load(path.to_str().unwrap(), None, "");
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.bytes, bytes);
        std::fs::write(&path, "<html>not an icon</html>").unwrap();
        assert!(cache.load(path.to_str().unwrap(), None, "").is_none());
        assert_eq!(cache.entries.len(), 2);
    }

    #[test]
    fn image_masks_clip_corners_and_tints_preserve_alpha() {
        let original = image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 20, 250, 128]));
        let mut circle = original.clone();
        apply_style(&mut circle, Some(Color::from_rgb8(255, 158, 100)), "circle");
        assert_eq!(circle.get_pixel(0, 0)[3], 0);
        assert_eq!(circle.get_pixel(16, 16).0, [255, 158, 100, 128]);
        assert!(circle.get_pixel(16, 0)[3] > 100);
        let mut rounded = original;
        apply_style(&mut rounded, None, "roundedRectangle");
        assert_eq!(rounded.get_pixel(0, 0)[3], 0);
        assert_eq!(rounded.get_pixel(16, 16).0, [0, 20, 250, 128]);
    }
}
