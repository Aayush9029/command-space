use super::model::{Config, config_dir, data_dir, home, shell_quote, state_dir};
use std::{collections::HashSet, fs, process::Command};

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("String serialization")
}

pub fn bindings(config: &Config) -> Result<String, String> {
    let binary = home()
        .join(".local/bin/command-space")
        .to_string_lossy()
        .into_owned();
    let binary = shell_quote(&binary);
    let mut keys = HashSet::new();
    let mut output = String::from(
        "o.window(\"^command-space$\", { float = true, center = true, border_size = 0, rounding = 0, no_anim = true, opacity = \"1 1\", tag = \"-default-opacity\" })\n",
    );
    let mut bind = |key: &str, title: &str, command: String| -> Result<(), String> {
        if key.trim().is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " +:_-".contains(c))
        {
            return Err(format!(
                "Invalid shortcut for {title}: use a shortcut such as SUPER + SPACE"
            ));
        }
        if !keys.insert(key.replace(' ', "").to_uppercase()) {
            return Err(format!("Shortcut {key} is assigned more than once"));
        }
        output.push_str(&format!(
            "hl.unbind({}); o.bind({}, {}, {})\n",
            quoted(key),
            quoted(key),
            quoted(title),
            quoted(&command)
        ));
        Ok(())
    };
    bind(
        &config.toggle_hotkey,
        "Command Space",
        format!("{binary} toggle"),
    )?;
    bind(
        &config.clipboard_hotkey,
        "Clipboard History",
        format!("{binary} toggle builtin:clipboard"),
    )?;
    bind(
        &config.emoji_hotkey,
        "Search Emoji",
        format!("{binary} toggle builtin:emoji"),
    )?;
    for shell in &config.shells {
        if let Some(key) = &shell.hotkey {
            bind(
                key,
                &shell.name,
                format!("{binary} run-shell {}", shell_quote(&shell.name)),
            )?;
        }
    }
    let root = std::env::var("OMARCHY_PATH").unwrap_or_else(|_| "/usr/share/omarchy".into());
    let defaults = fs::read_to_string(format!("{root}/default/hypr/bindings/utilities.lua"))
        .unwrap_or_default();
    for line in defaults
        .lines()
        .filter(|line| line.starts_with("o.bind(\"") && line.contains("omarchy-menu toggle"))
    {
        let Some(key) = line
            .strip_prefix("o.bind(\"")
            .and_then(|s| s.split('"').next())
        else {
            continue;
        };
        if key == "SUPER + SPACE" || keys.contains(&key.replace(' ', "").to_uppercase()) {
            continue;
        }
        let line = line.replace("omarchy-menu toggle", &format!("{binary} toggle"));
        output.push_str(&format!("hl.unbind({}); {line}\n", quoted(key)));
    }
    Ok(output)
}

pub fn apply(config: &Config) -> Result<(), String> {
    let lua = bindings(config)?;
    let hypr = home().join(".config/hypr");
    if !hypr.join("hyprland.lua").exists() {
        return Err("Omarchy's Hyprland Lua configuration was not found".into());
    }
    fs::create_dir_all(state_dir().join("backups")).map_err(|e| e.to_string())?;
    for name in ["hyprland.lua", "command-space.lua"] {
        let original = hypr.join(name);
        let backup = state_dir().join("backups").join(name);
        if original.exists() && !backup.exists() {
            fs::copy(&original, backup).map_err(|e| e.to_string())?;
        }
    }
    fs::write(hypr.join("command-space.lua"), lua).map_err(|e| e.to_string())?;
    let mut main = fs::read_to_string(hypr.join("hyprland.lua")).map_err(|e| e.to_string())?;
    if !main.contains("require(\"hypr.command-space\")") {
        main.push_str("\nrequire(\"hypr.command-space\")\n");
        fs::write(hypr.join("hyprland.lua"), main).map_err(|e| e.to_string())?;
    }
    if installed() {
        install_bar_widget()?;
        browser_bridge(false)?;
        let status = Command::new("systemctl")
            .args([
                "--user",
                if config.start_at_login {
                    "enable"
                } else {
                    "disable"
                },
                "command-space.service",
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not update launcher autostart".into());
        }
    }
    reload_desktop()?;
    Ok(())
}

pub fn installed() -> bool {
    home()
        .join(".config/systemd/user/command-space.service")
        .exists()
}

pub fn uninstall() -> Result<(), String> {
    browser_bridge(true)?;
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "command-space.service"])
        .status();
    update_bar_widget("command-space.launcher", "omarchy.menu")?;
    let plugin = home().join(".config/omarchy/plugins/command-space.launcher");
    if plugin.exists() {
        fs::remove_dir_all(plugin).map_err(|e| e.to_string())?;
    }
    let path = home().join(".config/hypr/hyprland.lua");
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    fs::write(path, text.replace("require(\"hypr.command-space\")", ""))
        .map_err(|e| e.to_string())?;
    for path in [
        home().join(".config/hypr/command-space.lua"),
        home().join(".local/bin/command-space"),
        home().join(".local/bin/command-space-menu"),
        home().join(".config/systemd/user/command-space.service"),
        home().join(".local/share/applications/command-space.desktop"),
    ] {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    reload_desktop()?;
    println!(
        "Removed desktop integration. Settings and extensions remain in {} and {}.",
        config_dir().display(),
        data_dir().display()
    );
    Ok(())
}

fn browser_bridge(remove: bool) -> Result<(), String> {
    let script = data_dir().join("runtime/install-browser.mjs");
    if !script.exists() {
        return Ok(());
    }
    let mut command = Command::new("node");
    command.arg(script);
    if remove {
        command.arg("--uninstall");
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Browser integration: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn reload_desktop() -> Result<(), String> {
    let environment = Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .map_err(|e| e.to_string())?;
    if !String::from_utf8_lossy(&environment.stdout)
        .lines()
        .any(|line| line.starts_with("HYPRLAND_INSTANCE_SIGNATURE="))
    {
        return Ok(());
    }
    let output = Command::new("systemd-run")
        .args([
            "--user",
            "--quiet",
            "--wait",
            "--pipe",
            "--collect",
            "hyprctl",
            "reload",
            "config-only",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().into())
    }
}

fn update_bar_widget(from: &str, to: &str) -> Result<(), String> {
    let path = home().join(".config/omarchy/shell.json");
    if !path.exists() && to == "omarchy.menu" {
        return Ok(());
    }
    let original = fs::read_to_string(if path.exists() {
        path.as_path()
    } else {
        std::path::Path::new("/usr/share/omarchy/config/omarchy/shell.json")
    })
    .map_err(|e| e.to_string())?;
    let mut config: serde_json::Value =
        serde_json::from_str(&original).map_err(|e| e.to_string())?;
    let mut changed = false;
    if let Some(layout) = config["bar"]["layout"].as_object_mut() {
        for entries in layout
            .values_mut()
            .filter_map(serde_json::Value::as_array_mut)
        {
            for entry in entries {
                if entry["id"] == from {
                    entry["id"] = to.into();
                    changed = true;
                }
            }
        }
    }
    if changed {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let backup = state_dir().join("backups/shell.json");
        if !backup.exists() {
            fs::write(backup, original).map_err(|e| e.to_string())?;
        }
        let temporary = path.with_extension("command-space.tmp");
        fs::write(
            &temporary,
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn install_bar_widget() -> Result<(), String> {
    let folder = home().join(".config/omarchy/plugins/command-space.launcher");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    fs::write(
        folder.join("manifest.json"),
        include_str!("../../scripts/omarchy-bar/manifest.json"),
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        folder.join("BarWidget.qml"),
        include_str!("../../scripts/omarchy-bar/BarWidget.qml"),
    )
    .map_err(|e| e.to_string())?;
    update_bar_widget("omarchy.menu", "command-space.launcher")?;
    let _ = Command::new("systemd-run")
        .args([
            "--user",
            "--quiet",
            "--wait",
            "--pipe",
            "--collect",
            "/usr/share/omarchy/bin/omarchy-shell",
            "shell",
            "rescanPlugins",
        ])
        .output();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_or_invalid_shortcuts_are_rejected() {
        let mut config = Config {
            clipboard_hotkey: "SUPER+SPACE".into(),
            ..Config::default()
        };
        assert!(bindings(&config).unwrap_err().contains("more than once"));
        config.clipboard_hotkey = "SUPER + '\"".into();
        assert!(bindings(&config).unwrap_err().contains("Invalid shortcut"));
    }
}
