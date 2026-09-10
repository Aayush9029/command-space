use super::model::home;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use walkdir::WalkDir;

type IconIndex = HashMap<String, String>;

#[derive(Default)]
struct IndexCache {
    icons: IconIndex,
    refreshed: Option<Instant>,
}

fn with_index<T>(use_index: impl FnOnce(&IconIndex) -> T) -> T {
    static CACHE: OnceLock<Mutex<IndexCache>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if cache
        .refreshed
        .is_none_or(|time| time.elapsed() >= Duration::from_secs(5))
    {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share"));
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"));
        let mut data = vec![data_home.clone()];
        data.extend(std::env::split_paths(
            &std::env::var_os("XDG_DATA_DIRS")
                .unwrap_or_else(|| "/usr/local/share:/usr/share".into()),
        ));
        let mut bases = vec![data_home.join("icons"), home().join(".icons")];
        bases.extend(data.iter().skip(1).map(|root| root.join("icons")));
        let theme = [
            config_home.join("gtk-3.0/settings.ini"),
            config_home.join("gtk-4.0/settings.ini"),
        ]
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .find_map(|source| {
            source.lines().find_map(|line| {
                let (key, value) = line.split_once('=')?;
                (key.trim() == "gtk-icon-theme-name")
                    .then(|| value.trim().trim_matches('"').to_owned())
            })
        })
        .unwrap_or_else(|| "Adwaita".into());
        cache.icons = build_index(&bases, &data, &theme);
        cache.refreshed = Some(Instant::now());
    }
    use_index(&cache.icons)
}

pub fn index() -> IconIndex {
    with_index(Clone::clone)
}

pub fn resolve(index: &IconIndex, name: &str) -> Option<String> {
    if Path::new(name).is_absolute() {
        return Path::new(name).is_file().then(|| name.to_owned());
    }
    index
        .get(name)
        .or_else(|| {
            let path = Path::new(name);
            matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("svg" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "ico" | "bmp")
            )
            .then(|| {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| index.get(stem))
            })
            .flatten()
        })
        .cloned()
}

fn build_index(bases: &[PathBuf], data: &[PathBuf], theme: &str) -> IconIndex {
    let mut pending = VecDeque::from([theme.to_owned()]);
    let mut themes = Vec::new();
    let mut seen = HashSet::new();
    while let Some(theme) = pending.pop_front() {
        if !seen.insert(theme.clone()) {
            continue;
        }
        for base in bases {
            if let Ok(source) = fs::read_to_string(base.join(&theme).join("index.theme")) {
                for line in source.lines() {
                    if let Some((key, value)) = line.split_once('=')
                        && key.trim() == "Inherits"
                    {
                        pending.extend(
                            value
                                .split(',')
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(str::to_owned),
                        );
                    }
                }
            }
        }
        themes.push(theme);
    }
    if !seen.contains("hicolor") {
        themes.push("hicolor".into());
    }
    let mut icons: HashMap<String, (i32, String)> = HashMap::new();
    for (priority, base) in bases.iter().enumerate() {
        for file in WalkDir::new(base)
            .follow_links(true)
            .max_depth(7)
            .sort_by_file_name()
            .into_iter()
            .filter_map(Result::ok)
            .filter(|file| file.file_type().is_file())
        {
            let path = file.path();
            if !matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("svg" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "ico" | "bmp")
            ) {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            let relative = path.strip_prefix(base).unwrap_or(path);
            let name_theme = relative
                .components()
                .next()
                .map(|component| component.as_os_str().to_string_lossy())
                .unwrap_or_default();
            let theme_score = themes
                .iter()
                .position(|theme| theme == &name_theme)
                .map_or(0, |rank| 1_000_000 / (rank as i32 + 1));
            let relative = relative.to_string_lossy();
            let size_score = if relative.contains("scalable/") {
                100
            } else if relative.contains("48x48/") {
                90
            } else if relative.contains("64x64/") {
                80
            } else if relative.contains("32x32/") {
                70
            } else {
                0
            };
            let score = theme_score + size_score - priority as i32;
            if icons
                .get(name)
                .is_none_or(|(previous, _)| score > *previous)
            {
                icons.insert(name.into(), (score, path.to_string_lossy().into()));
            }
        }
    }
    for root in data {
        for file in WalkDir::new(root.join("pixmaps"))
            .follow_links(true)
            .max_depth(2)
            .sort_by_file_name()
            .into_iter()
            .filter_map(Result::ok)
            .filter(|file| file.file_type().is_file())
        {
            if !matches!(
                file.path()
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("svg" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "ico" | "bmp")
            ) {
                continue;
            }
            if let Some(name) = file.path().file_stem().and_then(|name| name.to_str()) {
                icons
                    .entry(name.into())
                    .or_insert((-1000, file.path().to_string_lossy().into()));
            }
        }
    }
    icons
        .into_iter()
        .map(|(name, (_, path))| (name, path))
        .collect()
}

pub fn file_icon(path: &str) -> String {
    let path = Path::new(path);
    let kind = if path.is_dir() {
        "folder"
    } else {
        match path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg" | "avif" | "heic" => "image-x-generic",
            "mp4" | "webm" | "mkv" | "mov" | "avi" => "video-x-generic",
            "mp3" | "wav" | "ogg" | "flac" | "m4a" => "audio-x-generic",
            "pdf" => "application-pdf",
            "zip" | "gz" | "xz" | "zst" | "tar" | "7z" | "rar" => "package-x-generic",
            "rs" | "js" | "jsx" | "ts" | "tsx" | "py" | "c" | "cpp" | "go" | "java" | "json"
            | "toml" | "yaml" | "yml" => "text-x-script",
            "sh" | "bash" | "zsh" | "fish" => "text-x-shellscript",
            "html" | "htm" => "text-html",
            "desktop" | "exe" | "appimage" => "application-x-executable",
            _ => "text-x-generic",
        }
    };
    with_index(|index| index.get(kind).cloned())
        .unwrap_or_else(|| if path.is_dir() { "󰉋" } else { "󰈔" }.into())
}

pub fn builtin(name: &str) -> Option<String> {
    static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
    let catalog = CATALOG.get_or_init(|| {
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../runtime/icons/catalog.json"))
                .unwrap_or_default();
        catalog["icons"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(name, icon)| Some((name.clone(), icon["asset"].as_str()?.to_owned())))
            .collect()
    });
    let asset = catalog.get(name.strip_prefix("icon:").unwrap_or(name))?;
    let roots = [
        std::env::var_os("COMMAND_SPACE_RUNTIME").map(PathBuf::from),
        Some(super::model::data_dir().join("runtime")),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")),
    ];
    roots
        .into_iter()
        .flatten()
        .map(|root| root.join("icons").join(asset))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn entry<'a>(
    entry: &super::model::Entry,
    colors: super::appearance::Colors,
) -> iced::Element<'a, super::app::Message> {
    let source = if entry.icon.starts_with("icon:") {
        builtin(&entry.icon)
            .or_else(|| builtin("QuestionMarkCircle"))
            .unwrap_or_default()
    } else {
        entry.icon.clone()
    };
    if source.starts_with('/') {
        let tint = (entry.icon.starts_with("icon:") || source.ends_with("-symbolic.svg"))
            .then_some(colors.foreground);
        if let Some(image) =
            super::extension_image::file(&source, 28., 28., iced::ContentFit::Contain, tint, "")
        {
            return image;
        }
    }
    let symbol = if is_symbol(&source) {
        source.as_str()
    } else {
        "󰀻"
    };
    iced::widget::container(
        iced::widget::text(symbol.to_owned())
            .font(font(&entry.icon_font, symbol))
            .size(22)
            .color(colors.foreground),
    )
    .center(28)
    .clip(true)
    .into()
}

pub fn is_symbol(value: &str) -> bool {
    !value.is_empty()
        && (value.chars().count() <= 4 || (value.chars().count() <= 32 && !value.is_ascii()))
}

pub fn font(name: &str, symbol: &str) -> iced::Font {
    if name.is_empty() || name.len() > 256 {
        return if symbol.chars().any(|value| matches!(value as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)) {
            iced::Font::with_name("JetBrainsMono Nerd Font")
        } else { iced::Font::DEFAULT };
    }
    static FONTS: OnceLock<Mutex<HashMap<String, &'static str>>> = OnceLock::new();
    let mut fonts = FONTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let name = if let Some(name) = fonts.get(name) {
        *name
    } else if fonts.len() < 64 {
        let interned: &'static str = Box::leak(name.to_owned().into_boxed_str());
        fonts.insert(name.to_owned(), interned);
        interned
    } else {
        "JetBrainsMono Nerd Font"
    };
    iced::Font::with_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_theme_icons_precede_hicolor_and_extension_names_resolve() {
        let folder = tempfile::tempdir().unwrap();
        let base = folder.path().join("icons");
        for theme in ["Current", "Parent", "hicolor"] {
            fs::create_dir_all(base.join(theme).join("48x48/apps")).unwrap();
        }
        fs::write(
            base.join("Current/index.theme"),
            "[Icon Theme]\nInherits=Parent,hicolor\n",
        )
        .unwrap();
        fs::write(
            base.join("Parent/index.theme"),
            "[Icon Theme]\nInherits=Current\n",
        )
        .unwrap();
        for theme in ["Parent", "hicolor"] {
            fs::write(base.join(theme).join("48x48/apps/example.svg"), "fixture").unwrap();
        }
        let icons = build_index(&[base], &[], "Current");
        assert!(icons["example"].contains("Parent/"));
        assert_eq!(
            resolve(&icons, "example.svg"),
            Some(icons["example"].clone())
        );
    }
}
