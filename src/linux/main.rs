mod app;
mod appearance;
mod background;
mod catalog;
mod clipboard;
mod deeplink;
mod desktop;
mod extension_image;
mod extension_view;
mod extensions;
mod form_field;
mod icons;
mod integration;
mod ipc;
mod menu;
mod model;
mod settings;
mod tray;
mod tray_image;
#[path = "../unit_conversion.rs"]
mod unit_conversion;
mod updates;
mod windows;

fn main() -> iced::Result {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let verb = arguments.first().map(String::as_str).unwrap_or("toggle");
    let route = arguments.get(1).map(String::as_str).unwrap_or("root");
    let is_link = [
        "command-space://",
        "rustcast://",
        "raycast://",
        "com.raycast:/",
    ]
    .iter()
    .any(|prefix| verb.starts_with(prefix));
    if is_link {
        if let Err(error) = deeplink::parse(verb) {
            eprintln!("{error}");
            std::process::exit(2);
        }
        if ipc::send("link", verb).is_ok() {
            return Ok(());
        }
    }
    match verb {
        "clipboard-serve" => {
            if let Err(error) = clipboard::serve() {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return Ok(());
        }
        "paste" => {
            if let Err(error) = windows::paste() {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return Ok(());
        }
        "--version" | "version" => {
            println!("Command Space {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        "--help" | "help" => {
            println!(
                "command-space [toggle|show|hide] [route]\ncommand-space daemon\ncommand-space refresh|ping|quit\ncommand-space menu [route|dump|inspect]\ncommand-space search <query>\ncommand-space extension install <directory|github-url>\ncommand-space extension update|remove <name>\ncommand-space extension list\ncommand-space run-shell <name> [arguments...]\ncommand-space window <position> [window-id]\ncommand-space integration apply|uninstall\nUse builtin:settings, builtin:clipboard, or builtin:emoji for launcher routes."
            );
            return Ok(());
        }
        "integration" => {
            let result = match route {
                "apply" => model::Config::load().and_then(|config| integration::apply(&config)),
                "uninstall" => integration::uninstall(),
                _ => Err("Use integration apply or integration uninstall".into()),
            };
            if let Err(error) = result {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return Ok(());
        }
        "window" => {
            let context = windows::Context::capture(false);
            let id = arguments
                .get(2)
                .cloned()
                .or_else(|| context.previous.map(|c| c.id))
                .unwrap_or_default();
            if let Err(error) = windows::operate(route, &id) {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return Ok(());
        }
        "run-shell" => {
            let config = model::Config::load().unwrap_or_default();
            let Some(command) = config
                .shells
                .iter()
                .find(|s| s.name == route || s.alias.as_deref() == Some(route))
            else {
                eprintln!("Shell command not found: {route}");
                std::process::exit(1);
            };
            let status = std::process::Command::new("bash")
                .args(["-lc", &command.command, "command-space"])
                .args(&arguments[2..])
                .status();
            std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1));
        }
        "ping" => {
            if ipc::send("ping", "root").is_err() {
                std::process::exit(1);
            }
            println!("Command Space is running");
            return Ok(());
        }
        "extension" => {
            match arguments.get(1).map(String::as_str) {
                Some("install") => match arguments
                    .get(2)
                    .ok_or("Supply an extension source directory".to_string())
                    .and_then(|path| extensions::install_location(path, false))
                {
                    Ok(name) => println!("Installed {name}"),
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                },
                Some("update") => {
                    let result = arguments
                        .get(2)
                        .ok_or("Supply an extension name".to_string())
                        .and_then(|name| extensions::update(name));
                    match result {
                        Ok(name) => println!("Updated {name}"),
                        Err(error) => {
                            eprintln!("{error}");
                            std::process::exit(1);
                        }
                    }
                }
                Some("remove") => {
                    let result = arguments
                        .get(2)
                        .ok_or("Supply an extension name".to_string())
                        .and_then(|name| extensions::remove(name));
                    if let Err(error) = result {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                }
                _ => println!(
                    "{}",
                    serde_json::to_string_pretty(&extensions::entries()).unwrap()
                ),
            }
            return Ok(());
        }
        "applications" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&desktop::apps()).unwrap()
            );
            return Ok(());
        }
        "benchmark" => {
            let started = std::time::Instant::now();
            let (catalog, timings) = catalog::Catalog::load_profiled();
            let load_ms = started.elapsed().as_secs_f64() * 1000.;
            let config = model::Config::load().unwrap_or_default();
            let queries = ["install", "terminal", "clipboard", "json", "theme"];
            let mut samples = Vec::new();
            for iteration in 0..205 {
                let started = std::time::Instant::now();
                std::hint::black_box(catalog.search(
                    "root",
                    queries[iteration % queries.len()],
                    &config,
                    &[],
                ));
                if iteration >= 5 {
                    samples.push(started.elapsed().as_secs_f64() * 1000.);
                }
            }
            samples.sort_by(f64::total_cmp);
            println!(
                "{}",
                serde_json::json!({
                    "catalog_load_ms": load_ms,
                    "load_stages_ms": timings.into_iter().collect::<std::collections::BTreeMap<_,_>>(),
                    "applications": catalog.apps.len(),
                    "extension_commands": catalog.extensions.len(),
                    "search_ms": {"samples":samples.len(),"median":samples[samples.len()/2],"p95":samples[samples.len()*95/100]},
                    "measurement":"In-process catalog search; excludes event delivery and UI rendering"
                })
            );
            return Ok(());
        }
        "menu" => {
            match menu::Menu::load() {
                Ok(mut menu) => {
                    if route == "dump" {
                        println!("{}", serde_json::to_string_pretty(&menu.items).unwrap());
                    } else {
                        menu.evaluate_conditions();
                        if route == "inspect" {
                            let routes: std::collections::BTreeMap<_, _> = std::iter::once("root")
                                .chain(menu.items.iter().map(|item| item.id.as_str()))
                                .map(|route| (route, menu.entries(&menu.resolve(route), false)))
                                .collect();
                            println!(
                                "{}",
                                serde_json::json!({"items":menu.items,"conditions":menu.conditions,"checks":menu.checks,"routes":routes})
                            );
                        } else {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(
                                    &menu.entries(&menu.resolve(route), false)
                                )
                                .unwrap()
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
            return Ok(());
        }
        "search" => {
            let catalog = catalog::Catalog::load();
            let config = model::Config::load().unwrap_or_default();
            println!(
                "{}",
                serde_json::to_string_pretty(&catalog.search(
                    "root",
                    &arguments[1..].join(" "),
                    &config,
                    &[]
                ))
                .unwrap()
            );
            return Ok(());
        }
        "toggle" | "show" | "summon" | "hide" | "close" | "daemon" | "refresh" | "quit" => {}
        _ if is_link => {}
        _ => {
            eprintln!("Unknown command: {verb}. Use command-space --help.");
            std::process::exit(2);
        }
    }
    if !is_link && ipc::send(if verb == "daemon" { "ping" } else { verb }, route).is_ok() {
        return Ok(());
    }
    if matches!(verb, "hide" | "close" | "refresh" | "quit") {
        return Ok(());
    }
    let initial = if is_link {
        Some(format!("link:{verb}"))
    } else if verb == "daemon" {
        None
    } else {
        Some(route.to_string())
    };
    let font = model::Config::load().unwrap_or_default().font;
    tray::start();
    iced::daemon(
        move || app::Launcher::new(initial.clone()),
        app::Launcher::update,
        app::Launcher::view,
    )
    .title("Command Space")
    .subscription(app::Launcher::subscription)
    .theme(app::Launcher::theme)
    .settings(iced::Settings {
        default_font: iced::Font::with_name(Box::leak(font.into_boxed_str())),
        ..Default::default()
    })
    .run()
}
