use ksni::{MenuItem, blocking::TrayMethods, menu::StandardItem};

struct LauncherTray;

impl ksni::Tray for LauncherTray {
    fn id(&self) -> String {
        "command-space".into()
    }
    fn title(&self) -> String {
        "Command Space".into()
    }
    fn icon_name(&self) -> String {
        String::new()
    }
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        launcher_icon()
    }
    fn activate(&mut self, _: i32, _: i32) {
        let _ = super::ipc::send("toggle", "root");
    }
    fn menu(&self) -> Vec<MenuItem<Self>> {
        [
            ("Open Command Space", "show", "root"),
            ("Clipboard History", "show", "builtin:clipboard"),
            ("Extensions", "show", "builtin:extensions"),
            ("Settings", "show", "builtin:settings"),
            ("Reload Commands", "refresh", "root"),
            ("Quit", "quit", "root"),
        ]
        .into_iter()
        .map(|(title, verb, route)| {
            StandardItem {
                label: title.into(),
                activate: Box::new(move |_| {
                    let _ = super::ipc::send(verb, route);
                }),
                ..Default::default()
            }
            .into()
        })
        .collect()
    }
}

pub fn start() {
    std::thread::spawn(|| match LauncherTray.assume_sni_available(true).spawn() {
        Ok(_handle) => loop {
            std::thread::park();
        },
        Err(error) => eprintln!("System tray: {error}"),
    });
}

pub fn launcher_icon() -> Vec<ksni::Icon> {
    let mut argb = Vec::with_capacity(24 * 24 * 4);
    for y in 0i32..24 {
        for x in 0i32..24 {
            let distance = ((x as f32 - 9.0).powi(2) + (y as f32 - 9.0).powi(2)).sqrt();
            let ring = (5.0..=7.0).contains(&distance);
            let handle = (14..=21).contains(&x) && (14..=21).contains(&y) && (x - y).abs() <= 1;
            argb.extend_from_slice(&[if ring || handle { 255 } else { 0 }, 122, 162, 247]);
        }
    }
    vec![ksni::Icon {
        width: 24,
        height: 24,
        data: argb,
    }]
}
