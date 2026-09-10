use super::model::{Action, Entry, data_dir};
use iced::{Subscription, futures::SinkExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub commands: Vec<ExtensionCommand>,
    #[serde(default)]
    pub preferences: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExtensionCommand {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub mode: Option<String>,
    pub interval: Option<String>,
    #[serde(default)]
    pub arguments: Vec<Value>,
    #[serde(default)]
    pub preferences: Vec<Value>,
}

pub fn root() -> PathBuf {
    data_dir().join("extensions")
}

pub fn manifest(path: &Path) -> Result<Manifest, String> {
    let raw = fs::read_to_string(path.join("package.json")).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let valid = |name: &str| {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    if !valid(&manifest.name) || manifest.commands.iter().any(|c| !valid(&c.name)) {
        return Err("Extension and command names must contain only letters, digits, underscores, or hyphens".into());
    }
    Ok(manifest)
}

pub fn entries() -> Vec<Entry> {
    let mut entries = vec![];
    let Ok(folders) = fs::read_dir(root()) else {
        return entries;
    };
    for folder in folders
        .filter_map(Result::ok)
        .filter(|f| !f.file_name().to_string_lossy().starts_with('.'))
    {
        if let Ok(manifest) = manifest(&folder.path()) {
            let title = manifest.title.as_deref().unwrap_or(&manifest.name);
            let metadata: Value = fs::read(
                data_dir()
                    .join("extension-data")
                    .join(&manifest.name)
                    .join("command-metadata.json"),
            )
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
            for command in &manifest.commands {
                let subtitle = metadata[&command.name]["subtitle"]
                    .as_str()
                    .map(|value| format!("{title} · {value}"))
                    .unwrap_or_else(|| title.into());
                let icon = manifest
                    .icon
                    .as_ref()
                    .map(|icon| {
                        folder
                            .path()
                            .join("assets")
                            .join(icon)
                            .to_string_lossy()
                            .into_owned()
                    })
                    .unwrap_or_else(|| "󰏗".into());
                entries.push(Entry::new(
                    &format!("extension:{}:{}", manifest.name, command.name),
                    &command.title,
                    &subtitle,
                    &icon,
                    Action::Extension {
                        extension: manifest.name.clone(),
                        command: command.name.clone(),
                    },
                ));
            }
        }
    }
    entries.sort_by_key(|e| e.title.to_lowercase());
    entries
}

fn install_source(source: &Path, replace: bool) -> Result<String, String> {
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let manifest = manifest(&source)?;
    let destination = root().join(&manifest.name);
    if destination.exists() && !replace {
        return Err(format!("{} is already installed", manifest.name));
    }
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    static NEXT_INSTALL: AtomicU64 = AtomicU64::new(1);
    let staging = root().join(format!(
        ".install-{}-{}-{}",
        manifest.name,
        std::process::id(),
        NEXT_INSTALL.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        for file in walkdir::WalkDir::new(&source)
            .into_iter()
            .filter_entry(|entry| {
                !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "node_modules" | "target")
                )
            })
        {
            let file = file.map_err(|e| e.to_string())?;
            if file.file_type().is_symlink() {
                return Err("Extension sources must not contain symlinks".into());
            }
            let target = staging.join(
                file.path()
                    .strip_prefix(&source)
                    .map_err(|e| e.to_string())?,
            );
            if file.file_type().is_dir() {
                fs::create_dir_all(target).map_err(|e| e.to_string())?;
            } else {
                fs::copy(file.path(), target).map_err(|e| e.to_string())?;
            }
        }
        let raw: Value = serde_json::from_slice(
            &fs::read(staging.join("package.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if raw
            .get("dependencies")
            .and_then(Value::as_object)
            .is_some_and(|deps| !deps.is_empty())
        {
            let status = Command::new("npm")
                .args([
                    "install",
                    "--ignore-scripts",
                    "--omit=dev",
                    "--no-audit",
                    "--no-fund",
                ])
                .current_dir(&staging)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Extension dependency installation failed".into());
            }
        }
        let backup = staging.with_extension("backup");
        if destination.exists() {
            fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&staging, &destination) {
            if backup.exists() {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(error.to_string());
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(manifest.name.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

pub fn installed() -> Vec<Manifest> {
    let mut manifests = fs::read_dir(root())
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|folder| !folder.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|folder| manifest(&folder.path()).ok())
        .collect::<Vec<_>>();
    manifests.sort_by_key(|m| m.title.as_ref().unwrap_or(&m.name).to_lowercase());
    manifests
}

pub fn remove(name: &str) -> Result<(), String> {
    let installed = installed()
        .into_iter()
        .find(|m| m.name == name)
        .ok_or("Extension is not installed")?;
    fs::remove_dir_all(root().join(installed.name)).map_err(|e| e.to_string())
}

pub fn install_location(location: &str, replace: bool) -> Result<String, String> {
    if !location.starts_with("https://github.com/") {
        let source = Path::new(location)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let name = install_source(&source, replace)?;
        fs::write(
            root().join(&name).join(".command-space-source"),
            source.to_string_lossy().as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        return Ok(name);
    }
    let url = url::Url::parse(location).map_err(|e| e.to_string())?;
    let parts: Vec<_> = url
        .path_segments()
        .ok_or("Invalid GitHub source URL")?
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() < 2 || (parts.len() > 2 && (parts.get(2) != Some(&"tree") || parts.len() < 5)) {
        return Err("Use a GitHub repository URL or the URL of an extension folder".into());
    }
    let checkout = root().join(format!(
        ".download-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let result = (|| {
        let repository = format!(
            "https://github.com/{}/{}.git",
            parts[0],
            parts[1].trim_end_matches(".git")
        );
        let mut git = Command::new("git");
        git.args([
            "clone",
            "--depth=1",
            "--filter=blob:none",
            "--no-checkout",
            "--single-branch",
        ]);
        if parts.len() > 2 {
            git.args(["--branch", parts[3]]);
        }
        let status = git
            .arg("--")
            .arg(repository)
            .arg(&checkout)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not download the extension repository".into());
        }
        let subdir = if parts.len() > 4 {
            parts[4..].join("/")
        } else {
            String::new()
        };
        if !subdir.is_empty() {
            let status = Command::new("git")
                .args(["sparse-checkout", "set", "--cone", "--", &subdir])
                .current_dir(&checkout)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Could not select the extension folder".into());
            }
        }
        let status = Command::new("git")
            .args(["checkout"])
            .current_dir(&checkout)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not check out the extension source".into());
        }
        let name = install_source(&checkout.join(subdir), replace)?;
        fs::write(root().join(&name).join(".command-space-source"), location)
            .map_err(|e| e.to_string())?;
        Ok(name)
    })();
    let _ = fs::remove_dir_all(checkout);
    result
}

pub fn update(name: &str) -> Result<String, String> {
    let installed = installed()
        .into_iter()
        .find(|m| m.name == name)
        .ok_or("Extension is not installed")?;
    let location = fs::read_to_string(root().join(installed.name).join(".command-space-source"))
        .map_err(|_| {
            "Choose the extension source folder or GitHub URL to update this extension".to_string()
        })?;
    install_location(location.trim(), true)
}

pub fn management_entries(route: &str) -> Vec<Entry> {
    if let Some(name) = route.strip_prefix("extension-manage:") {
        let mut entries = entries().into_iter().filter(|entry| matches!(&entry.action, Action::Extension { extension, .. } if extension == name)).collect::<Vec<_>>();
        for key in super::background::enabled() {
            if let Some((extension, command)) = key.split_once('/')
                && extension == name
            {
                entries.push(Entry::new(
                    &format!("extension-stop:{key}"),
                    &format!("Stop {command}"),
                    "Deactivate background refresh and remove its tray item",
                    "",
                    Action::Builtin(format!("extension-stop:{key}")),
                ));
            }
        }
        entries.push(Entry::new(
            "extension-update",
            "Update extension",
            "Download the latest version from its saved source",
            "",
            Action::Builtin(format!("extension-update:{name}")),
        ));
        entries.push(Entry::new(
            "extension-replace",
            "Update from source folder",
            "Select a new copy of this extension",
            "󰉋",
            Action::Builtin(format!("extension-replace:{name}")),
        ));
        entries.push(Entry::new(
            "extension-remove",
            "Uninstall extension",
            "Settings and stored data are kept",
            "󰆴",
            Action::Builtin(format!("extension-remove:{name}")),
        ));
        entries.push(Entry::new(
            "extension-source",
            "Open extension folder",
            "View the installed source files",
            "󰉋",
            Action::Open(root().join(name).to_string_lossy().into()),
        ));
        entries
    } else {
        let mut entries = vec![
            Entry::new(
                "extension-install",
                "Install Extension",
                "Choose a TypeScript or JavaScript extension folder",
                "󰏗",
                Action::Builtin("extension-install".into()),
            ),
            Entry::new(
                "extension-download",
                "Install from GitHub",
                "Paste a repository or extension folder URL",
                "󰊤",
                Action::Builtin("extension-download".into()),
            ),
        ];
        entries.extend(installed().into_iter().map(|m| {
            Entry::new(
                &format!("extension-manage:{}", m.name),
                m.title.as_deref().unwrap_or(&m.name),
                &format!("{} commands · Manage installation", m.commands.len()),
                "󰏗",
                Action::Builtin(format!("extension-manage:{}", m.name)),
            )
        }));
        entries
    }
}

fn events() -> &'static tokio::sync::broadcast::Sender<(u64, Value)> {
    static EVENTS: OnceLock<tokio::sync::broadcast::Sender<(u64, Value)>> = OnceLock::new();
    EVENTS.get_or_init(|| tokio::sync::broadcast::channel(128).0)
}

pub fn emit(id: u64, event: Value) {
    let _ = events().send((id, event));
}

pub struct Session {
    pub id: u64,
    pub extension: String,
    pub command: String,
    pub mode: String,
    input: ChildStdin,
    process: Child,
}

impl Session {
    pub fn start(
        extension: &str,
        command: &str,
        arguments: Value,
        context: &super::windows::Context,
    ) -> Result<Self, String> {
        Self::start_with_options(extension, command, arguments, Value::Null, context, false)
    }

    pub fn start_with_options(
        extension: &str,
        command: &str,
        arguments: Value,
        launch_context: Value,
        context: &super::windows::Context,
        background: bool,
    ) -> Result<Self, String> {
        let definition = installed()
            .into_iter()
            .find(|m| m.name == extension)
            .and_then(|m| m.commands.into_iter().find(|c| c.name == command))
            .ok_or_else(|| format!("Extension command is not installed: {extension}/{command}"))?;
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let runtime = std::env::var_os("COMMAND_SPACE_RUNTIME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let installed = data_dir().join("runtime");
                if installed.join("host.mjs").exists() {
                    installed
                } else {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")
                }
            });
        let mut process = Command::new("node")
            .arg(runtime.join("host.mjs"))
            .env(
                "COMMAND_SPACE_AI_CONFIG",
                serde_json::to_string(&super::model::Config::load().unwrap_or_default().ai)
                    .map_err(|e| e.to_string())?,
            )
            .env(
                "COMMAND_SPACE_FRONTMOST",
                serde_json::to_string(&context.previous).map_err(|e| e.to_string())?,
            )
            .env(
                "COMMAND_SPACE_BINARY",
                std::env::current_exe().map_err(|e| e.to_string())?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Starting extension runtime: {e}"))?;
        let input = process.stdin.take().ok_or("Extension stdin unavailable")?;
        let output = process
            .stdout
            .take()
            .ok_or("Extension stdout unavailable")?;
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(output).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(value) = serde_json::from_str(&line) {
                    let _ = events().send((id, value));
                }
            }
            let _ = events().send((id, json!({"type":"exited"})));
        });
        let mut session = Self {
            id,
            input,
            process,
            extension: extension.into(),
            command: command.into(),
            mode: definition.mode.unwrap_or_else(|| "view".into()),
        };
        let mut message = json!({"type":"launch","extension":root().join(extension),"command":command,"launchType":if background { "background" } else { "userInitiated" }});
        if !arguments.is_null() {
            message["arguments"] = arguments;
        }
        if !launch_context.is_null() {
            message["launchContext"] = launch_context;
        }
        session.send(message)?;
        Ok(session)
    }

    pub fn send(&mut self, message: Value) -> Result<(), String> {
        writeln!(self.input, "{message}").map_err(|e| e.to_string())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

pub fn subscription() -> Subscription<super::app::Message> {
    Subscription::run(|| {
        stream::channel(
            32,
            |mut output: iced::futures::channel::mpsc::Sender<super::app::Message>| async move {
                let mut receiver = events().subscribe();
                loop {
                    match receiver.recv().await {
                        Ok((id, message)) => {
                            if output
                                .send(super::app::Message::Extension(id, message))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            },
        )
    })
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Node {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub props: Value,
    #[serde(default)]
    pub children: Vec<Node>,
}

impl Node {
    pub fn text(&self, key: &str) -> &str {
        self.props[key].as_str().unwrap_or("")
    }
    pub fn callback(&self, key: &str) -> Option<String> {
        self.props[key]["$callback"].as_str().map(String::from)
    }
    pub fn descendants(&self) -> Vec<&Node> {
        std::iter::once(self)
            .chain(self.children.iter().flat_map(|n| n.descendants()))
            .collect()
    }
}
