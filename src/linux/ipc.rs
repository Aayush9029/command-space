use super::app::Message;
use iced::{Subscription, futures::SinkExt, stream};
use std::{io::Write, path::PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

pub fn socket_path() -> PathBuf {
    use std::os::unix::fs::MetadataExt;
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(format!(
                "/run/user/{}",
                std::fs::metadata("/proc/self")
                    .expect("Linux process metadata is available")
                    .uid()
            ))
        })
        .join("command-space.sock")
}

pub fn send(command: &str, route: &str) -> std::io::Result<()> {
    let mut socket = std::os::unix::net::UnixStream::connect(socket_path())?;
    writeln!(
        socket,
        "{}",
        serde_json::json!({"command":command,"route":route})
    )
}

pub fn subscription() -> Subscription<Message> {
    Subscription::run(|| {
        stream::channel(
            32,
            |mut output: iced::futures::channel::mpsc::Sender<Message>| async move {
                let path = socket_path();
                if path.exists() && std::os::unix::net::UnixStream::connect(&path).is_err() {
                    let _ = std::fs::remove_file(&path);
                }
                let listener = match tokio::net::UnixListener::bind(&path) {
                    Ok(l) => l,
                    Err(error) => {
                        let _ = output
                            .send(Message::Result(Err(format!("Command socket: {error}"))))
                            .await;
                        return;
                    }
                };
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                while let Ok((socket, _)) = listener.accept().await {
                    let mut reader = tokio::io::BufReader::new(socket.take(65537));
                    let mut line = String::new();
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        reader.read_line(&mut line),
                    )
                    .await;
                    if !matches!(result, Ok(Ok(_))) || line.len() > 65536 {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        let route = value["route"].as_str().unwrap_or("root").to_string();
                        let message = match value["command"].as_str().unwrap_or("toggle") {
                            "hide" | "close" => Message::Hide,
                            "show" | "summon" => Message::Show(route, false),
                            "toggle" => Message::Show(route, true),
                            "refresh" => Message::Reload,
                            "quit" => Message::Quit,
                            "link" => Message::DeepLink(route),
                            _ => Message::Noop,
                        };
                        let _ = output.send(message).await;
                    }
                }
            },
        )
    })
}
