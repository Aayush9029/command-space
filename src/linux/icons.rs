use super::model::home;
use std::{collections::HashMap, fs, path::PathBuf};
use walkdir::WalkDir;

pub fn index() -> HashMap<String, String> {
    let mut bases = vec![home().join(".icons"), home().join(".local/share/icons")];
    let data: Vec<_> = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".into())
        .split(':')
        .map(PathBuf::from)
        .collect();
    bases.extend(data.iter().map(|root| root.join("icons")));
    let theme = [
        home().join(".config/gtk-3.0/settings.ini"),
        home().join(".config/gtk-4.0/settings.ini"),
    ]
    .iter()
    .filter_map(|file| fs::read_to_string(file).ok())
    .flat_map(|source| {
        source
            .lines()
            .filter_map(|line| {
                line.strip_prefix("gtk-icon-theme-name=")
                    .map(|value| value.trim().trim_matches('"').to_owned())
            })
            .collect::<Vec<_>>()
    })
    .next()
    .unwrap_or_else(|| "Adwaita".into());
    let mut icons: HashMap<String, (i32, String)> = HashMap::new();
    for (priority, base) in bases.iter().enumerate() {
        for file in WalkDir::new(base)
            .follow_links(true)
            .max_depth(7)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|file| file.file_type().is_file())
        {
            let path = file.path();
            if !matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("svg" | "png")
            ) {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            let relative = path.strip_prefix(base).unwrap_or(path).to_string_lossy();
            let theme_score = if relative.starts_with(&format!("{theme}/")) {
                1000
            } else if relative.starts_with("hicolor/") {
                500
            } else {
                0
            };
            let size_score = if relative.contains("scalable/") {
                100
            } else if relative.contains("48x48/") {
                90
            } else if relative.contains("64x64/") {
                80
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
            .max_depth(2)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|file| file.file_type().is_file())
        {
            if !matches!(
                file.path()
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("svg" | "png")
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
