use super::model::{Action, Entry, data_dir};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct Release {
    pub available: bool,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub url: String,
    pub message: String,
}

pub async fn check() -> Result<Release, String> {
    let output = tokio::process::Command::new("bun")
        .arg(data_dir().join("runtime/updater.mjs"))
        .args(["check", env!("CARGO_PKG_VERSION")])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

pub async fn install(version: String) -> Result<(), String> {
    let output = tokio::process::Command::new("systemd-run")
        .args([
            "--user",
            "--quiet",
            "--collect",
            "--unit=command-space-update",
        ])
        .arg(format!(
            "--setenv=PATH={}",
            std::env::var("PATH").unwrap_or_default()
        ))
        .arg("bun")
        .arg(data_dir().join("runtime/updater.mjs"))
        .args(["install", &version, env!("CARGO_PKG_VERSION")])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().into())
    }
}

pub fn entries(release: &Release) -> Vec<Entry> {
    let mut entries = vec![];
    if release.available {
        entries.push(Entry::new(
            "install-update",
            &format!("Install Command Space {}", release.version),
            "Download the verified Linux package and restart the launcher",
            "",
            Action::Builtin("install-update".into()),
        ));
        entries.push(Entry::new(
            "release-notes",
            "Read release notes",
            &release.version,
            "󰈔",
            Action::Open(release.url.clone()),
        ));
    } else {
        entries.push(Entry::new(
            "update-status",
            &release.message,
            &format!("Installed version {}", env!("CARGO_PKG_VERSION")),
            "",
            Action::Builtin("updates".into()),
        ));
    }
    entries.push(Entry::new(
        "check-updates",
        "Check again",
        "Check the Command Space GitHub releases",
        "",
        Action::Builtin("updates".into()),
    ));
    entries
}
