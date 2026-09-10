use super::{Menu, MenuItem};
use crate::model::{Action, Entry, home, shell_quote};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, path::Path, process::Command};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Picker {
    Keybindings,
    Tmux,
    Herdr,
    Themes,
    Backgrounds,
    Unlock,
    Timezone,
    Plugins(&'static str),
    Packages(&'static str),
    RemoveTheme,
    RemoveLauncher(&'static str),
    DockerDatabases,
    Webcams,
}

fn picker(command: &str) -> Option<Picker> {
    match command.trim() {
        "omarchy-menu-keybindings" => Some(Picker::Keybindings),
        "omarchy-menu-tmux-keybindings" => Some(Picker::Tmux),
        "omarchy-menu-herdr-keybindings" => Some(Picker::Herdr),
        "theme=$(omarchy-theme-switcher); [[ -n $theme ]] && omarchy-theme-set \"$theme\"" => {
            Some(Picker::Themes)
        }
        "background=$(omarchy-theme-bg-switcher); [[ -n $background ]] && omarchy-theme-bg-set \"$background\"" => {
            Some(Picker::Backgrounds)
        }
        "unlock=$(omarchy-plymouth-switcher); if [[ $unlock == default ]]; then omarchy-launch-floating-terminal-with-presentation omarchy-plymouth-reset; elif [[ -n $unlock ]]; then omarchy-launch-floating-terminal-with-presentation \"omarchy-plymouth-set-by-theme $(printf %q \"$unlock\")\"; fi" => {
            Some(Picker::Unlock)
        }
        "omarchy-menu-timezone" => Some(Picker::Timezone),
        "omarchy-menu-plugin enable" => Some(Picker::Plugins("enable")),
        "omarchy-menu-plugin disable" => Some(Picker::Plugins("disable")),
        "omarchy-menu-plugin clone" => Some(Picker::Plugins("clone")),
        "omarchy-menu-plugin remove" => Some(Picker::Plugins("remove")),
        "xdg-terminal-exec --app-id=org.omarchy.terminal omarchy-pkg-install" => {
            Some(Picker::Packages("install"))
        }
        "xdg-terminal-exec --app-id=org.omarchy.terminal omarchy-pkg-aur-install" => {
            Some(Picker::Packages("aur"))
        }
        "xdg-terminal-exec --app-id=org.omarchy.terminal omarchy-pkg-remove" => {
            Some(Picker::Packages("remove"))
        }
        "omarchy-theme-remove" => Some(Picker::RemoveTheme),
        "omarchy-webapp-remove" => Some(Picker::RemoveLauncher("webapp")),
        "omarchy-tui-remove" => Some(Picker::RemoveLauncher("tui")),
        "omarchy-launch-floating-terminal-with-presentation omarchy-install-docker-dbs" => {
            Some(Picker::DockerDatabases)
        }
        "omarchy-capture-screenrecording-with-webcam" => Some(Picker::Webcams),
        _ => None,
    }
}

pub(super) fn action(item: &MenuItem) -> Option<Action> {
    let workflow = match item.action.trim() {
        "omarchy-webapp-install"
        | "omarchy-launch-floating-terminal-with-presentation omarchy-webapp-install" => {
            Some("install-web-app")
        }
        "omarchy-tui-install"
        | "omarchy-launch-floating-terminal-with-presentation omarchy-tui-install" => {
            Some("install-tui")
        }
        "omarchy-reminder -i" | "omarchy-reminder --interactive" => Some("reminder"),
        "omarchy-reminder show" | "omarchy-reminder list" => Some("reminders"),
        "omarchy-reminder clear" => Some("clear-reminders"),
        "omarchy-transcode" => Some("transcode"),
        "omarchy-menu-share file" => Some("share-files"),
        "omarchy-menu-share folder" => Some("share-folder"),
        "omarchy-branding-about image" => Some("about-image"),
        "omarchy-branding-screensaver image" => Some("screensaver-image"),
        "omarchy-theme-bg-install" => Some("install-wallpaper"),
        "omarchy-theme-install"
        | "omarchy-launch-floating-terminal-with-presentation omarchy-theme-install" => {
            Some("install-theme")
        }
        "omarchy-plugin-add"
        | "omarchy-launch-floating-terminal-with-presentation 'omarchy-plugin-add'" => {
            Some("add-shell-plugin")
        }
        "omarchy-games-retro-install" => Some("install-retro-game"),
        "omarchy-dns Custom"
        | "omarchy-launch-floating-terminal-with-presentation 'omarchy-dns Custom'" => {
            Some("custom-dns")
        }
        "omarchy-setup-security-sshd"
        | "omarchy-launch-floating-terminal-with-presentation omarchy-setup-security-sshd" => {
            Some("setup-sshd")
        }
        "omarchy-windows-vm install"
        | "omarchy-launch-floating-terminal-with-presentation 'omarchy-windows-vm install'" => {
            Some("install-windows")
        }
        "omarchy-drive-password"
        | "omarchy-launch-floating-terminal-with-presentation omarchy-drive-password" => {
            Some("drive-password")
        }
        "omarchy-branding-about text" => Some("about-text"),
        "omarchy-branding-screensaver text" => Some("screensaver-text"),
        "omarchy-branding-about reset" => Some("about-reset"),
        "omarchy-branding-screensaver reset" => Some("screensaver-reset"),
        _ => None,
    };
    if let Some(command) = workflow {
        return Some(Action::Extension {
            extension: "omarchy-tools".into(),
            command: command.into(),
        });
    }
    if item.action.trim() == "omarchy-menu-emoji" {
        return Some(Action::Builtin("emoji".into()));
    }
    if picker(&item.action).is_some() {
        return Some(Action::Menu(item.id.clone()));
    }
    let words = shell_words::split(&item.action).ok()?;
    match words.as_slice() {
        [command] if command == "omarchy-menu" => Some(Action::Menu("root".into())),
        [command, verb]
            if command == "omarchy-menu" && matches!(verb.as_str(), "toggle" | "summon") =>
        {
            Some(Action::Menu("root".into()))
        }
        [command, verb, route]
            if command == "omarchy-menu" && matches!(verb.as_str(), "toggle" | "summon") =>
        {
            Some(Action::Menu(route.clone()))
        }
        _ => None,
    }
}

#[derive(Serialize, Deserialize)]
struct Confirmation {
    title: String,
    detail: String,
    command: String,
}

pub(super) fn confirmation(title: String, detail: &str, command: String) -> Action {
    Action::Menu(format!(
        "native-confirm:{}",
        serde_json::to_string(&Confirmation {
            title,
            detail: detail.into(),
            command,
        })
        .unwrap()
    ))
}

pub(super) fn package_operation(command: &str) -> Option<super::packages::Operation> {
    match picker(command) {
        Some(Picker::Packages("install")) => Some(super::packages::Operation::Install),
        Some(Picker::Packages("aur")) => Some(super::packages::Operation::Aur),
        Some(Picker::Packages("remove")) => Some(super::packages::Operation::Remove),
        _ => None,
    }
}

fn parse_confirmation(route: &str) -> Option<Confirmation> {
    serde_json::from_str(route.strip_prefix("native-confirm:")?).ok()
}

pub(super) fn title(route: &str) -> Option<String> {
    parse_confirmation(route).map(|confirmation| confirmation.title)
}

fn output(script: &str) -> Result<String, String> {
    let output = Command::new("timeout")
        .args(["45", "bash", "-lc", script])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "The system command could not load this list".into()
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn text_file(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap_or_default().trim().into()
}

fn terminal(command: &str) -> String {
    format!(
        "omarchy-launch-floating-terminal-with-presentation {}",
        shell_quote(command)
    )
}

fn row(item: &MenuItem, id: &str, label: &str, description: &str, action: Action) -> Entry {
    let mut entry = Entry::new(
        &format!("{}.native.{id}", item.id),
        label,
        description,
        &item.icon,
        action,
    );
    entry.icon_font = item.icon_font.clone();
    entry
}

fn checked(label: &str, value: &str, current: &str) -> String {
    if value == current {
        format!("{label} ✓")
    } else {
        label.into()
    }
}

pub(super) fn provider(menu: &Menu, route: &str) -> Option<Vec<Entry>> {
    if let Some(confirmation) = parse_confirmation(route) {
        return Some(vec![
            Entry::new(
                "native-confirm:cancel",
                "Cancel",
                "",
                "󰜺",
                Action::Builtin("back".into()),
            ),
            Entry::new(
                "native-confirm:accept",
                &confirmation.title,
                &confirmation.detail,
                "󰩹",
                Action::Shell(confirmation.command),
            ),
        ]);
    }
    let item = menu.items.iter().find(|item| item.id == route)?;
    let picker = picker(&item.action)?;
    Some(match load(item, picker) {
        Ok(rows) => rows,
        Err(error) => vec![row(
            item,
            "retry",
            "Could not load items",
            &error,
            Action::Menu(route.into()),
        )],
    })
}

fn load(item: &MenuItem, picker: Picker) -> Result<Vec<Entry>, String> {
    match picker {
        Picker::Keybindings | Picker::Tmux | Picker::Herdr => keybindings(item, picker),
        Picker::Themes | Picker::Unlock | Picker::RemoveTheme => themes(item, picker),
        Picker::Backgrounds => backgrounds(item),
        Picker::Plugins(operation) => plugins(item, operation),
        Picker::Packages(operation) => packages(item, operation),
        Picker::RemoveLauncher(kind) => launchers(item, kind),
        Picker::DockerDatabases => {
            let path = output("command -v omarchy-install-docker-dbs")?;
            let source = fs::read_to_string(path.trim()).map_err(|error| error.to_string())?;
            let choices = source.lines().find_map(|line| line.strip_prefix("options=(")?.strip_suffix(')')).ok_or("Database choices were not found in the installed installer")?;
            let choices = shell_words::split(choices).map_err(|error| error.to_string())?;
            Ok(choices.iter().map(|name| row(item, name, name, "Docker container", Action::Shell(terminal(&format!("omarchy-install-docker-dbs {}", shell_quote(name)))))).collect())
        }
        Picker::Webcams => Ok(output("omarchy-capture-webcam-list")?.lines().filter_map(|line| {
            let device = line.split_whitespace().next()?;
            Some(row(item, device, line, "Record with desktop and microphone audio", Action::Shell(format!("omarchy-capture-screenrecording --with-desktop-audio --with-microphone-audio --with-webcam --webcam-device={}", shell_quote(device)))))
        }).collect()),
        Picker::Timezone => {
            let current =
                output("timedatectl show --property=Timezone --value").unwrap_or_default();
            Ok(output("timedatectl list-timezones")?.lines().map(|zone| {
                let command = format!("sudo timedatectl set-timezone {} && omarchy-shell -q omarchy.clock refresh && omarchy-notification-send {}", shell_quote(zone), shell_quote(&format!("Timezone is now set to {zone}")));
                row(item, zone, &checked(zone, zone, current.trim()), "", Action::Shell(terminal(&command)))
            }).collect())
        }
    }
}

fn keybindings(item: &MenuItem, picker: Picker) -> Result<Vec<Entry>, String> {
    let command = match picker {
        Picker::Keybindings => "omarchy-menu-keybindings",
        Picker::Tmux => "omarchy-menu-tmux-keybindings",
        _ => "omarchy-menu-herdr-keybindings",
    };
    Ok(output(&format!("{command} --print"))?.lines().enumerate().filter_map(|(index, line)| {
        let (keys, label) = line.split_once('→')?;
        let action = if picker == Picker::Keybindings {
            // Let the installed script resolve Lua dispatchers and user keybindings after native selection.
            Action::Shell(format!("omarchy-menu-select() {{ printf '%s\\n' {}; }}; export -f omarchy-menu-select; {command}", shell_quote(line)))
        } else {
            Action::Copy(format!("{} → {}", keys.trim(), label.trim()))
        };
        Some(row(item, &index.to_string(), label.trim(), keys.trim(), action))
    }).collect())
}

fn theme_names(remove: bool) -> Result<Vec<String>, String> {
    let script = if remove {
        "find ~/.config/omarchy/themes -mindepth 1 -maxdepth 1 -type d ! -xtype l -printf '%f\\n' 2>/dev/null | sort"
    } else {
        "{ find ~/.config/omarchy/themes -mindepth 1 -maxdepth 1 \\( -type d -o -type l \\) -printf '%f\\n' 2>/dev/null; find \"$OMARCHY_PATH/themes\" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'; } | sort -u"
    };
    Ok(output(script)?
        .lines()
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect())
}

fn themes(item: &MenuItem, picker: Picker) -> Result<Vec<Entry>, String> {
    let (names, current) = if picker == Picker::Unlock {
        let mut names = vec!["default".into()];
        names.extend(output("omarchy-plymouth-list")?.lines().map(String::from));
        (
            names,
            output("omarchy-plymouth-current")
                .unwrap_or_default()
                .trim()
                .into(),
        )
    } else {
        (
            theme_names(picker == Picker::RemoveTheme)?,
            text_file(home().join(".local/state/omarchy/current/theme.name")),
        )
    };
    Ok(names
        .iter()
        .map(|name| {
            let label = display_name(name);
            let action = match picker {
                Picker::Unlock => Action::Shell(terminal(&if name == "default" {
                    "omarchy-plymouth-reset".into()
                } else {
                    format!("omarchy-plymouth-set-by-theme {}", shell_quote(name))
                })),
                Picker::RemoveTheme => confirmation(
                    format!("Remove {label}"),
                    "The installed theme folder will be deleted",
                    format!("omarchy-theme-remove {}", shell_quote(name)),
                ),
                _ => Action::Shell(format!("omarchy-theme-set {}", shell_quote(name))),
            };
            row(item, name, &checked(&label, name, &current), "", action)
        })
        .collect())
}

fn display_name(name: &str) -> String {
    name.split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().collect::<String>() + chars.as_str()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn backgrounds(item: &MenuItem) -> Result<Vec<Entry>, String> {
    let theme = text_file(home().join(".local/state/omarchy/current/theme.name"));
    let current = fs::canonicalize(home().join(".local/state/omarchy/current/background")).ok();
    let roots = [
        home().join(".config/omarchy/backgrounds").join(theme),
        home().join(".local/state/omarchy/current/theme/backgrounds"),
    ];
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for root in roots {
        let mut files = fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|file| file.path())
            .collect::<Vec<_>>();
        files.sort();
        for path in files {
            let extension = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !path.is_file()
                || !matches!(
                    extension.as_str(),
                    "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
                )
            {
                continue;
            }
            let resolved = fs::canonicalize(&path).unwrap_or(path);
            if !seen.insert(resolved.clone()) {
                continue;
            }
            let value = resolved.to_string_lossy();
            let label = resolved.file_name().unwrap_or_default().to_string_lossy();
            let title = if current.as_ref() == Some(&resolved) {
                format!("{label} ✓")
            } else {
                label.into()
            };
            rows.push(row(
                item,
                &value,
                &title,
                "",
                Action::Shell(format!("omarchy-theme-bg-set {}", shell_quote(&value))),
            ));
        }
    }
    Ok(rows)
}

fn plugins(item: &MenuItem, operation: &str) -> Result<Vec<Entry>, String> {
    let plugins: Vec<Value> = serde_json::from_str(&output("omarchy-plugin-list --json")?)
        .map_err(|error| error.to_string())?;
    Ok(plugin_rows(item, operation, &plugins))
}

fn plugin_rows(item: &MenuItem, operation: &str, plugins: &[Value]) -> Vec<Entry> {
    plugins
        .iter()
        .filter(|plugin| match operation {
            "enable" => plugin["enabled"] != true,
            "disable" => plugin["canDisable"] == true && plugin["enabled"] == true,
            "clone" => {
                plugin["firstParty"] == true
                    && !plugins
                        .iter()
                        .any(|other| other["clonedFrom"] == plugin["id"])
            }
            "remove" => plugin["firstParty"] != true,
            _ => false,
        })
        .filter_map(|plugin| {
            let id = plugin["id"].as_str()?;
            let name = plugin["name"].as_str().unwrap_or(id);
            let command = format!(
                "omarchy-plugin-{operation} {}{}",
                shell_quote(id),
                if operation == "clone" { " --edit" } else { "" }
            );
            let action = match operation {
                "remove" => confirmation(
                    format!("Remove {name}"),
                    "The shell plugin will be removed",
                    format!("{command} --yes"),
                ),
                "clone" => Action::Shell(terminal(&command)),
                _ => Action::Shell(command),
            };
            Some(row(item, id, name, id, action))
        })
        .collect()
}

fn packages(item: &MenuItem, operation: &str) -> Result<Vec<Entry>, String> {
    let script = match operation {
        "install" => "pacman -Sl",
        "aur" => "yay -Slqa",
        _ => "pacman -Qqe",
    };
    let text = output(script)?;
    let mut seen = HashSet::new();
    Ok(text
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let (name, description) = if operation == "install" {
                let name = *fields.get(1)?;
                (
                    name,
                    format!(
                        "{} · {}{}",
                        fields[0],
                        fields.get(2).copied().unwrap_or_default(),
                        if fields.len() > 3 {
                            " · Installed"
                        } else {
                            ""
                        }
                    ),
                )
            } else {
                (
                    *fields.first()?,
                    if operation == "aur" {
                        "AUR"
                    } else {
                        "Installed package"
                    }
                    .into(),
                )
            };
            if !seen.insert(name.to_string()) {
                return None;
            }
            let command = match operation {
                "install" => format!("sudo pacman -S -- {}", shell_quote(name)),
                "aur" => format!("yay -S -- {}", shell_quote(&format!("aur/{name}"))),
                _ => format!("sudo pacman -Rns -- {}", shell_quote(name)),
            };
            let action = if operation == "remove" {
                confirmation(
                    format!("Remove {name}"),
                    "Review dependencies in the package manager before confirming removal",
                    terminal(&command),
                )
            } else {
                Action::Shell(terminal(&command))
            };
            Some(row(item, name, name, &description, action))
        })
        .collect())
}

fn launchers(item: &MenuItem, kind: &str) -> Result<Vec<Entry>, String> {
    let root = home().join(".local/share/applications");
    let mut pending = vec![root];
    let mut names = Vec::new();
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).into_iter().flatten().flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push(path);
                continue;
            }
            if path
                .extension()
                .is_none_or(|extension| extension != "desktop")
            {
                continue;
            }
            let text = fs::read_to_string(&path).unwrap_or_default();
            let matches = text
                .lines()
                .filter_map(|line| line.strip_prefix("Exec="))
                .any(|exec| {
                    if kind == "webapp" {
                        exec.contains("omarchy-launch-webapp")
                            || exec.contains("omarchy-webapp-handler")
                    } else {
                        (exec.contains("$TERMINAL") || exec.contains("xdg-terminal-exec"))
                            && exec.contains("-e")
                    }
                });
            if matches {
                names.push(
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    names.sort();
    Ok(names
        .iter()
        .map(|name| {
            row(
                item,
                name,
                name,
                "",
                confirmation(
                    format!("Remove {name}"),
                    "The app launcher and its icon will be removed",
                    format!("omarchy-{kind}-remove {}", shell_quote(name)),
                ),
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_adapters_preserve_custom_actions() {
        let mut menu = Menu::default();
        menu.merge(r#"{"trigger":{"label":"Trigger"},"trigger.emoji":{"action":"omarchy-menu-emoji","aliases":["emoji"]},"learn":{"label":"Learn"},"learn.keys":{"action":"omarchy-menu-keybindings"},"install":{"label":"Install"},"install.package":{"action":"xdg-terminal-exec --app-id=org.omarchy.terminal omarchy-pkg-install"}}"#).unwrap();
        assert_eq!(menu.resolve("emoji"), "emoji");
        assert_eq!(
            menu.entries("trigger", false)[0].action,
            Action::Builtin("emoji".into())
        );
        assert_eq!(
            menu.entries("learn", false)[0].action,
            Action::Menu("learn.keys".into())
        );
        assert_eq!(
            menu.entries("install", false)[0].action,
            Action::Menu("install.package".into())
        );
        menu.merge(r#"{"learn.keys":{"action":"custom-keybindings"}}"#)
            .unwrap();
        assert_eq!(
            menu.entries("learn", false)[0].action,
            Action::Shell("custom-keybindings".into())
        );
    }

    #[test]
    fn shell_plugin_choices_respect_capabilities_and_require_remove_confirmation() {
        let plugins = serde_json::json!([
            {"id":"first","name":"First","enabled":true,"canDisable":true,"firstParty":true},
            {"id":"core","name":"Core","enabled":true,"canDisable":false,"firstParty":true},
            {"id":"clone","name":"Clone","enabled":false,"firstParty":false,"clonedFrom":"first"}
        ]);
        let item = MenuItem {
            id: "plugins".into(),
            ..Default::default()
        };
        let plugins = plugins.as_array().unwrap();
        assert_eq!(plugin_rows(&item, "enable", plugins)[0].title, "Clone");
        assert_eq!(plugin_rows(&item, "disable", plugins)[0].title, "First");
        assert_eq!(plugin_rows(&item, "clone", plugins)[0].title, "Core");
        let remove = plugin_rows(&item, "remove", plugins);
        let Action::Menu(route) = &remove[0].action else {
            panic!("Removal must stay in the launcher until confirmed")
        };
        let choices = provider(&Menu::default(), route).unwrap();
        assert_eq!(choices[0].title, "Cancel");
        assert!(matches!(choices[1].action, Action::Shell(_)));
    }
}
