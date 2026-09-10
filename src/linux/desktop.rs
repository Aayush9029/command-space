use super::model::{Action, Entry, home};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

pub fn apps() -> Vec<Entry> {
    let mut roots = vec![
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share")),
    ];
    roots.extend(
        std::env::var("XDG_DATA_DIRS")
            .unwrap_or_else(|_| "/usr/local/share:/usr/share".into())
            .split(':')
            .map(PathBuf::from),
    );
    let mut seen = HashSet::new();
    let mut entries = vec![];
    for root in roots {
        let applications = root.join("applications");
        for file in WalkDir::new(&applications)
            .follow_links(true)
            .max_depth(5)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "desktop")
            })
        {
            let id = file
                .path()
                .strip_prefix(&applications)
                .unwrap()
                .to_string_lossy()
                .replace('/', "-");
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(entry) = parse_entry(&id, file.path()) {
                entries.push(entry);
            }
        }
    }
    let icons = super::icons::index();
    for entry in &mut entries {
        if !entry.icon.starts_with('/')
            && let Some(path) = icons.get(&entry.icon)
        {
            entry.icon = path.clone();
        }
    }
    entries.sort_by_key(|e| e.title.to_lowercase());
    entries
}

fn parse_entry(id: &str, path: &Path) -> Option<Entry> {
    let raw = fs::read_to_string(path).ok()?;
    let mut inside = false;
    let mut fields = HashMap::new();
    for line in raw.lines() {
        if line.starts_with('[') {
            inside = line.trim() == "[Desktop Entry]";
            continue;
        }
        if inside && let Some((key, value)) = line.split_once('=') {
            fields.insert(key.trim(), value.trim());
        }
    }
    if fields.get("Type") != Some(&"Application")
        || fields.get("Hidden") == Some(&"true")
        || fields.get("NoDisplay") == Some(&"true")
    {
        return None;
    }
    let desktops = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_else(|_| "Hyprland".into());
    if let Some(only) = fields.get("OnlyShowIn")
        && !only.split(';').any(|d| desktops.split(':').any(|x| x == d))
    {
        return None;
    }
    if let Some(exclude) = fields.get("NotShowIn")
        && exclude
            .split(';')
            .any(|d| desktops.split(':').any(|x| x == d))
    {
        return None;
    }
    if let Some(program) = fields.get("TryExec")
        && !executable_exists(program)
    {
        return None;
    }
    let lang = std::env::var("LC_MESSAGES")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    let locale = lang.split('.').next().unwrap_or("");
    let language = locale.split('_').next().unwrap_or("");
    let name = fields
        .get(format!("Name[{locale}]").as_str())
        .or_else(|| fields.get(format!("Name[{language}]").as_str()))
        .or_else(|| fields.get("Name"))?;
    let mut entry = Entry::new(
        &format!("app:{id}"),
        name,
        fields.get("Comment").copied().unwrap_or("Application"),
        fields.get("Icon").copied().unwrap_or(""),
        Action::Desktop(path.to_string_lossy().into()),
    );
    entry.keywords = format!(
        "{} {} {}",
        fields.get("GenericName").copied().unwrap_or(""),
        fields.get("Keywords").copied().unwrap_or(""),
        id
    );
    Some(entry)
}

fn executable_exists(program: &str) -> bool {
    if program.contains('/') {
        return Path::new(program).is_file();
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|p| p.join(program).is_file())
}

pub fn files(roots: &[String], query: &str, still_current: impl Fn() -> bool) -> Vec<Entry> {
    let query = query.to_lowercase();
    if query.chars().count() < 2 {
        return vec![];
    }
    let mut entries = vec![];
    for root in roots {
        let path = if let Some(relative) = root.strip_prefix("~/") {
            home().join(relative)
        } else {
            PathBuf::from(root)
        };
        for item in WalkDir::new(path)
            .max_depth(12)
            .into_iter()
            .filter_entry(|e| {
                !e.file_name().to_string_lossy().starts_with('.')
                    && !matches!(
                        e.file_name().to_str(),
                        Some("node_modules" | "target" | "vendor")
                    )
            })
            .filter_map(Result::ok)
            .take(80_000)
        {
            if !still_current() {
                return vec![];
            }
            let name = item.file_name().to_string_lossy();
            if !name.to_lowercase().contains(&query) {
                continue;
            }
            let path = item.path().to_string_lossy();
            entries.push(Entry::new(
                &format!("file:{path}"),
                &name,
                &path,
                if item.file_type().is_dir() {
                    "󰉋"
                } else {
                    "󰈔"
                },
                Action::Open(path.to_string()),
            ));
            if entries.len() >= 200 {
                return entries;
            }
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_section_does_not_take_action_names() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("example.desktop");
        fs::write(&file, "[Desktop Entry]\nType=Application\nName=Example App\nExec=example %U\n[Desktop Action private]\nName=Private Window\nExec=example --private\n").unwrap();
        let app = parse_entry("example.desktop", &file).unwrap();
        assert_eq!(app.title, "Example App");
        assert_eq!(app.action, Action::Desktop(file.to_string_lossy().into()));
    }
}
