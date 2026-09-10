use crate::{
    app::Message,
    appearance::Colors,
    model::{Action, Entry, shell_quote},
};
use iced::{
    Element,
    Length::Fill,
    widget::{self, button, column, container, row, scrollable, text},
};
use std::{
    collections::{BTreeSet, HashMap},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Operation {
    Install,
    Aur,
    Remove,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum PreviewKind {
    #[default]
    Metadata,
    BuildScript,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PreviewKey {
    operation: Operation,
    name: String,
    kind: PreviewKind,
}

#[derive(Clone, Debug)]
pub struct PreviewRequest {
    key: PreviewKey,
    generation: u64,
    current_generation: Arc<AtomicU64>,
}

#[derive(Default)]
pub struct Selection {
    route: String,
    selected: BTreeSet<String>,
    cache: HashMap<PreviewKey, String>,
    current: Option<PreviewKey>,
    generation: Arc<AtomicU64>,
    pub kind: PreviewKind,
    pub preview_hidden: bool,
}

impl Selection {
    pub fn clear(&mut self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.route.clear();
        self.selected.clear();
        self.cache.clear();
        self.current = None;
        self.kind = PreviewKind::Metadata;
    }

    pub fn enter(&mut self, route: &str) {
        if self.route != route {
            self.clear();
            self.route = route.into();
        }
    }

    pub fn toggle(&mut self, name: &str) {
        if !self.selected.remove(name) {
            self.selected.insert(name.into());
        }
    }

    pub fn clear_selected(&mut self) {
        self.selected.clear();
    }
    pub fn contains(&self, name: &str) -> bool {
        self.selected.contains(name)
    }
    pub fn names(&self, current: Option<&str>) -> Vec<String> {
        if self.selected.is_empty() {
            current.into_iter().map(String::from).collect()
        } else {
            self.selected.iter().cloned().collect()
        }
    }

    pub fn primary(&self, operation: Operation) -> String {
        let verb = if operation == Operation::Remove {
            "Remove"
        } else {
            "Install"
        };
        if self.selected.is_empty() {
            verb.into()
        } else {
            format!("{verb} {}", self.selected.len())
        }
    }

    pub fn request(&mut self, operation: Operation, name: &str) -> Option<PreviewRequest> {
        let key = PreviewKey {
            operation,
            name: name.into(),
            kind: self.kind,
        };
        if self.current.as_ref() == Some(&key) {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        self.current = Some(key.clone());
        if self.cache.contains_key(&key) {
            return None;
        }
        Some(PreviewRequest {
            key,
            generation,
            current_generation: self.generation.clone(),
        })
    }

    pub fn complete(&mut self, request: PreviewRequest, body: String) {
        if self.generation.load(Ordering::Relaxed) != request.generation {
            return;
        }
        if self.cache.len() >= 64 {
            self.cache.clear();
        }
        self.cache.insert(request.key, body);
    }

    fn preview(&self) -> &str {
        self.current
            .as_ref()
            .and_then(|key| self.cache.get(key))
            .map(String::as_str)
            .unwrap_or("Loading…")
    }
}

pub fn name<'a>(route: &str, entry: &'a Entry) -> Option<&'a str> {
    entry
        .id
        .strip_prefix(route)?
        .strip_prefix(".native.")
        .filter(|name| !name.is_empty() && *name == entry.title)
}

pub fn action(operation: Operation, names: &[String]) -> Option<Action> {
    if names.is_empty() {
        return None;
    }
    let arguments = names
        .iter()
        .map(|name| {
            shell_quote(&if operation == Operation::Aur {
                format!("aur/{name}")
            } else {
                name.clone()
            })
        })
        .collect::<Vec<_>>()
        .join(" ");
    let command = match operation {
        Operation::Install => format!("sudo pacman -S -- {arguments}"),
        Operation::Aur => format!("yay -S -- {arguments}"),
        Operation::Remove => format!("sudo pacman -Rns -- {arguments}"),
    };
    let command = format!(
        "omarchy-launch-floating-terminal-with-presentation {}",
        shell_quote(&command)
    );
    Some(if operation == Operation::Remove {
        super::native::confirmation(
            format!(
                "Remove {} package{}",
                names.len(),
                if names.len() == 1 { "" } else { "s" }
            ),
            &names.join(", "),
            command,
        )
    } else {
        Action::Shell(command)
    })
}

impl PreviewRequest {
    pub async fn run(self) -> Option<(Self, String)> {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        if self.current_generation.load(Ordering::Relaxed) != self.generation {
            return None;
        }
        let key = self.key.clone();
        let body = tokio::task::spawn_blocking(move || load_preview(&key))
            .await
            .unwrap_or_else(|error| error.to_string());
        Some((self, body))
    }
}

fn load_preview(key: &PreviewKey) -> String {
    let command = match (key.operation, key.kind) {
        (Operation::Aur, PreviewKind::BuildScript) => {
            format!("yay -Gpa -- {}", shell_quote(&key.name))
        }
        (Operation::Aur, _) => format!("yay -Siia -- {}", shell_quote(&key.name)),
        (Operation::Remove, _) => format!("pacman -Qi -- {}", shell_quote(&key.name)),
        _ => format!("pacman -Sii -- {}", shell_quote(&key.name)),
    };
    match Command::new("timeout")
        .args(["30", "bash", "-lc", &command])
        .env("LC_ALL", "C")
        .output()
    {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            if text.trim().is_empty() {
                "No package details available".into()
            } else {
                text.chars().take(128 * 1024).collect()
            }
        }
        Ok(output) => {
            let error = String::from_utf8_lossy(&output.stderr);
            if error.trim().is_empty() {
                "Package details could not be loaded".into()
            } else {
                error.trim().chars().take(1024).collect()
            }
        }
        Err(error) => format!("Package details could not be loaded: {error}"),
    }
}

pub fn view<'a>(
    route: &'a str,
    entries: &'a [Entry],
    selected: usize,
    selection: &'a Selection,
    colors: Colors,
) -> Element<'a, Message> {
    let mut list = column![].spacing(2).padding(8);
    for (index, entry) in entries.iter().enumerate() {
        let package = name(route, entry);
        let checked = package.is_some_and(|name| selection.contains(name));
        let checkbox = widget::tooltip(
            button(
                container(
                    container(
                        text(if checked { "✓" } else { "" })
                            .size(11)
                            .font(iced::Font::with_name("JetBrainsMono Nerd Font")),
                    )
                    .center(15)
                    .style(move |_| container::Style {
                        background: Some(
                            if checked {
                                colors.foreground
                            } else {
                                colors.background
                            }
                            .into(),
                        ),
                        text_color: Some(colors.background),
                        border: iced::Border {
                            color: colors.muted,
                            width: 1.,
                            radius: 2.into(),
                        },
                        ..Default::default()
                    }),
                )
                .center(Fill),
            )
            .padding([6, 8])
            .width(34)
            .height(48)
            .style(move |_, status| colors.row(index == selected, status))
            .on_press(Message::PackageToggle(index, 0)),
            if checked {
                "Deselect package (Tab)"
            } else {
                "Select package (Tab)"
            },
            widget::tooltip::Position::Bottom,
        );
        list = list.push(
            row![
                checkbox,
                button(
                    column![
                        text(&entry.title)
                            .size(14)
                            .wrapping(widget::text::Wrapping::None),
                        text(&entry.subtitle)
                            .size(11)
                            .color(colors.muted)
                            .wrapping(widget::text::Wrapping::None),
                    ]
                    .spacing(3)
                )
                .padding([6, 6])
                .height(48)
                .width(Fill)
                .style(move |_, status| colors.row(index == selected, status))
                .on_press(Message::Activate(index))
            ]
            .spacing(2),
        );
    }
    let list = scrollable(list).id("results").height(Fill).width(Fill);
    if selection.preview_hidden {
        return list.into();
    }
    row![
        list,
        widget::rule::vertical(1).style(move |_| colors.divider()),
        scrollable(container(preview(selection, colors)).padding(18))
            .id("package-preview")
            .height(Fill)
            .width(Fill),
    ]
    .into()
}

#[derive(Debug, PartialEq, Eq)]
struct MetadataField {
    label: String,
    value: String,
}

fn parse_metadata(body: &str) -> Option<Vec<MetadataField>> {
    let mut fields: Vec<MetadataField> = Vec::new();
    for line in body.lines().filter(|line| !line.trim().is_empty()) {
        if line.starts_with(char::is_whitespace) {
            if let Some(field) = fields.last_mut() {
                field.value.push(if field.label == "Optional Deps" {
                    '\n'
                } else {
                    ' '
                });
                field.value.push_str(line.trim());
            }
            continue;
        }
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        let label = label.trim();
        if label.is_empty() {
            continue;
        }
        fields.push(MetadataField {
            label: label.into(),
            value: value.trim().into(),
        });
    }
    fields
        .iter()
        .any(|field| field.label == "Name" && !field.value.is_empty())
        .then_some(fields)
}

fn is_package_list(label: &str) -> bool {
    matches!(
        label,
        "Depends On"
            | "Optional Deps"
            | "Make Deps"
            | "Check Deps"
            | "Required By"
            | "Optional For"
            | "Conflicts With"
            | "Replaces"
            | "Provides"
    )
}

fn metadata_label(label: &str) -> &str {
    match label {
        "Depends On" => "Dependencies",
        "Optional Deps" => "Optional dependencies",
        "Make Deps" => "Build dependencies",
        "Check Deps" => "Test dependencies",
        "Required By" => "Required by",
        "Optional For" => "Optional for",
        "Conflicts With" => "Conflicts",
        "Installed Size" => "Installed size",
        "Download Size" => "Download size",
        "Package Base" => "Package base",
        "First Submitted" => "Submitted",
        "Last Modified" => "Updated",
        "Out-of-date" => "Out of date",
        "Build Date" => "Built",
        "Install Date" => "Installed",
        "Install Reason" => "Install reason",
        "Validated By" => "Validation",
        _ => label,
    }
}

fn metadata_row<'a>(label: &str, value: &str, colors: Colors) -> Element<'a, Message> {
    row![
        text(metadata_label(label).to_owned())
            .size(12)
            .color(colors.muted)
            .width(90),
        text(value.to_owned()).size(13).width(Fill),
    ]
    .spacing(10)
    .align_y(iced::Alignment::Start)
    .into()
}

fn preview(selection: &Selection, colors: Colors) -> Element<'_, Message> {
    let body = selection.preview();
    if selection.kind == PreviewKind::BuildScript {
        return text(body).size(12).font(iced::Font::MONOSPACE).into();
    }
    let Some(fields) = parse_metadata(body) else {
        return text(body).size(13).color(colors.muted).into();
    };
    let value = |label| {
        fields
            .iter()
            .find(|field| field.label == label)
            .map(|field| field.value.as_str())
            .unwrap_or("")
    };
    let mut content = column![text(value("Name").to_owned()).size(21)].spacing(12);
    if !value("Description").is_empty() {
        content = content.push(text(value("Description").to_owned()).size(14));
    }
    let mut summary = column![].spacing(9);
    let summary_labels = [
        "Version",
        "Repository",
        "Installed Size",
        "Download Size",
        "Architecture",
        "Licenses",
    ];
    for label in summary_labels {
        let value = value(label);
        if !value.is_empty() && value != "None" {
            summary = summary.push(metadata_row(label, value, colors));
        }
    }
    content = content.push(summary);
    let url = value("URL");
    if url.starts_with("https://") || url.starts_with("http://") {
        let host = url
            .split("://")
            .nth(1)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or(url);
        content = content.push(widget::tooltip(
            button(
                row![
                    text(host.to_owned()).size(13),
                    text("↗").size(13).color(colors.muted)
                ]
                .spacing(6),
            )
            .padding([5, 0])
            .style(move |_, status| colors.row(false, status))
            .on_press(Message::Url(url.to_owned())),
            container(text(url.to_owned()).size(12))
                .padding([6, 8])
                .style(move |_| colors.panel()),
            widget::tooltip::Position::Top,
        ));
    }
    let details: Vec<_> = fields
        .iter()
        .filter(|field| {
            !matches!(field.label.as_str(), "Name" | "Description" | "URL")
                && !summary_labels.contains(&field.label.as_str())
                && !is_package_list(&field.label)
                && !field.value.is_empty()
                && field.value != "None"
        })
        .collect();
    if !details.is_empty() {
        content = content.push(widget::rule::horizontal(1).style(move |_| colors.divider()));
        let mut rows = column![].spacing(9);
        for field in details {
            rows = rows.push(metadata_row(&field.label, &field.value, colors));
        }
        content = content.push(rows);
    }
    for field in fields.iter().filter(|field| {
        is_package_list(&field.label) && !field.value.is_empty() && field.value != "None"
    }) {
        content = content.push(widget::rule::horizontal(1).style(move |_| colors.divider()));
        let mut section = column![
            text(metadata_label(&field.label).to_owned())
                .size(12)
                .color(colors.muted)
        ]
        .spacing(8);
        if field.label == "Optional Deps" {
            for dependency in field.value.lines() {
                section = section.push(text(dependency.to_owned()).size(13));
            }
        } else {
            section = section.push(
                text(
                    field
                        .value
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(", "),
                )
                .size(13),
            );
        }
        content = content.push(section);
    }
    content.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_metadata_keeps_wrapped_descriptions_and_dependency_details() {
        let fields = parse_metadata("Repository      : core\nName            : example\nVersion         : 2.0-1\nDescription     : A useful package\n                  with a wrapped description\nURL             : https://example.org:8443/project\nDepends On      : alpha>=2  beta\n                  gamma\nOptional Deps   : delta: enables optional input\n                  epsilon: enables optional output [installed]\n").unwrap();
        let value = |label| {
            fields
                .iter()
                .find(|field| field.label == label)
                .unwrap()
                .value
                .as_str()
        };
        assert_eq!(value("Name"), "example");
        assert_eq!(
            value("Description"),
            "A useful package with a wrapped description"
        );
        assert_eq!(value("URL"), "https://example.org:8443/project");
        assert_eq!(value("Depends On"), "alpha>=2  beta gamma");
        assert_eq!(
            value("Optional Deps"),
            "delta: enables optional input\nepsilon: enables optional output [installed]"
        );
        assert!(parse_metadata("error: package not found").is_none());
        assert!(parse_metadata("Loading…").is_none());
    }

    #[test]
    fn selections_survive_filters_and_batch_arguments_are_quoted() {
        let mut selection = Selection::default();
        selection.enter("install.aur");
        selection.toggle("one");
        selection.toggle("two");
        selection.enter("install.aur");
        assert_eq!(selection.names(Some("other")), vec!["one", "two"]);
        let Action::Shell(command) = action(Operation::Aur, &selection.names(None)).unwrap() else {
            panic!()
        };
        assert!(command.contains("aur/one") && command.contains("aur/two"));
        selection.toggle("one");
        assert_eq!(selection.names(None), vec!["two"]);
        selection.enter("remove.package");
        assert_eq!(selection.selected.len(), 0);
        let Action::Menu(route) = action(Operation::Remove, &["one".into(), "two".into()]).unwrap()
        else {
            panic!()
        };
        assert!(route.starts_with("native-confirm:"));
        assert!(route.contains("Remove 2 packages"));
    }

    #[test]
    fn stale_package_previews_never_replace_the_current_selection() {
        let mut selection = Selection::default();
        let old = selection.request(Operation::Install, "one").unwrap();
        let current = selection.request(Operation::Install, "two").unwrap();
        selection.complete(old, "outdated".into());
        assert_eq!(selection.preview(), "Loading…");
        selection.complete(current, "current".into());
        assert_eq!(selection.preview(), "current");
        assert!(selection.request(Operation::Install, "two").is_none());
    }
}
