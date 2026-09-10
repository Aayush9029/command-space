use super::{
    app::Message,
    appearance::Colors,
    extensions::Node,
    model::{Action, Entry},
};
use iced::{
    Element,
    Length::Fill,
    keyboard::{Key, Modifiers, key::Named},
    widget::{
        self, button, checkbox, column, container, row, scrollable, text, text_editor, text_input,
    },
};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
pub struct ExtensionView {
    pub focused: String,
    pub tag_selection: HashMap<String, usize>,
    pub nodes: Vec<Node>,
    pub fields: HashMap<String, Value>,
    pub editors: HashMap<String, text_editor::Content>,
    input_revision: u64,
    pending_fields: HashMap<String, u64>,
    markdown: HashMap<String, Vec<widget::markdown::Item>>,
    pages: HashMap<String, HashMap<String, Value>>,
}

impl ExtensionView {
    pub fn edit_field(&mut self, id: &str, value: Value) -> u64 {
        self.input_revision += 1;
        self.fields.insert(id.into(), value);
        self.pending_fields.insert(id.into(), self.input_revision);
        self.input_revision
    }

    pub fn update(&mut self, nodes: Vec<Node>, acknowledged_revision: u64) {
        if self.root().map(|n| &n.id) != nodes.first().map(|n| &n.id) {
            self.focused.clear();
            self.tag_selection.clear();
            if let Some(root) = self.root() {
                self.pages
                    .insert(root.id.clone(), std::mem::take(&mut self.fields));
            }
            self.fields = nodes
                .first()
                .and_then(|n| self.pages.remove(&n.id))
                .unwrap_or_default();
            self.editors.clear();
            self.pending_fields.clear();
        }
        self.markdown.clear();
        for node in nodes.iter().flat_map(Node::descendants) {
            if !node.text("markdown").is_empty() {
                self.markdown.insert(
                    node.id.clone(),
                    widget::markdown::parse(node.text("markdown")).collect(),
                );
            }
            if node.kind.starts_with("Form.") {
                let id = node.text("id");
                if !id.is_empty() {
                    if self
                        .pending_fields
                        .get(id)
                        .is_some_and(|revision| *revision > acknowledged_revision)
                    {
                        continue;
                    }
                    self.pending_fields.remove(id);
                    if let Some(value) = node.props.get("value") {
                        self.fields.insert(id.into(), value.clone());
                    } else {
                        self.fields.entry(id.into()).or_insert_with(|| {
                            node.props.get("defaultValue").cloned().unwrap_or(
                                if node.kind == "Form.Checkbox" {
                                    json!(false)
                                } else if node.kind == "Form.Dropdown" {
                                    node.descendants()
                                        .into_iter()
                                        .find(|item| item.kind == "Form.Dropdown.Item")
                                        .map(|item| json!(item.text("value")))
                                        .unwrap_or(json!(""))
                                } else if matches!(
                                    node.kind.as_str(),
                                    "Form.FilePicker" | "Form.TagPicker"
                                ) {
                                    json!([])
                                } else {
                                    json!("")
                                },
                            )
                        });
                    }
                }
            }
        }
        for node in nodes
            .iter()
            .flat_map(Node::descendants)
            .filter(|node| node.kind == "Form.TextArea")
        {
            let id = node.text("id");
            let value = self.fields.get(id).and_then(Value::as_str).unwrap_or("");
            if self
                .editors
                .get(id)
                .is_none_or(|editor| editor.text() != value)
            {
                self.editors
                    .insert(id.into(), text_editor::Content::with_text(value));
            }
        }
        self.nodes = nodes;
    }

    pub fn root(&self) -> Option<&Node> {
        self.nodes.first()
    }

    pub fn form_fields(&self) -> Vec<&Node> {
        self.nodes
            .iter()
            .flat_map(Node::descendants)
            .filter(|node| node.kind.starts_with("Form.") && !node.text("id").is_empty())
            .collect()
    }

    pub fn next_field(&self, backwards: bool) -> Option<String> {
        let fields = self.form_fields();
        let current = fields
            .iter()
            .position(|node| node.text("id") == self.focused);
        let index = match current {
            Some(index) if backwards => (index + fields.len() - 1) % fields.len(),
            Some(index) => (index + 1) % fields.len(),
            None => 0,
        };
        fields.get(index).map(|node| node.text("id").into())
    }

    pub fn find(&self, id: &str) -> Option<&Node> {
        self.nodes
            .iter()
            .flat_map(Node::descendants)
            .find(|node| node.id == id)
    }

    pub fn entries(&self, query: &str) -> Vec<Entry> {
        let filter = self.root().is_none_or(|root| {
            root.props["filtering"]
                .as_bool()
                .unwrap_or_else(|| root.callback("onSearchTextChange").is_none())
        });
        self.nodes
            .iter()
            .flat_map(Node::descendants)
            .filter(|node| matches!(node.kind.as_str(), "List.Item" | "Grid.Item"))
            .filter(|node| {
                !filter
                    || format!(
                        "{} {} {}",
                        node.text("title"),
                        node.text("subtitle"),
                        node.props["keywords"]
                    )
                    .to_lowercase()
                    .contains(&query.to_lowercase())
            })
            .map(|node| {
                let icon = node.props["icon"]
                    .as_str()
                    .or(node.props["icon"]["source"].as_str())
                    .unwrap_or("󰏗");
                Entry::new(
                    &format!("extension-item:{}", node.id),
                    node.text("title"),
                    node.text("subtitle"),
                    icon,
                    Action::Builtin(format!("extension-item:{}", node.id)),
                )
            })
            .collect()
    }

    pub fn actions(&self, selected_id: Option<&str>) -> Vec<&Node> {
        self.panel_nodes(selected_id, None)
            .into_iter()
            .flat_map(Node::descendants)
            .filter(|node| node.kind == "Action" || node.kind == "Action.SubmitForm")
            .collect()
    }

    pub fn panel_nodes(&self, selected_id: Option<&str>, submenu: Option<&str>) -> Vec<&Node> {
        fn collect<'a>(node: &'a Node, result: &mut Vec<&'a Node>) {
            if matches!(
                node.kind.as_str(),
                "Action" | "Action.SubmitForm" | "ActionPanel.Submenu"
            ) {
                result.push(node);
            } else if matches!(node.kind.as_str(), "ActionPanel" | "ActionPanel.Section") {
                for child in &node.children {
                    collect(child, result);
                }
            }
        }
        let mut result = Vec::new();
        if let Some(node) = submenu.and_then(|id| self.find(id)) {
            for child in &node.children {
                collect(child, &mut result);
            }
            return result;
        }
        let selected =
            selected_id.and_then(|id| self.find(id.trim_start_matches("extension-item:")));
        let panel = selected
            .and_then(|node| {
                node.children
                    .iter()
                    .find(|child| child.kind == "ActionPanel")
            })
            .or_else(|| {
                self.root().and_then(|node| {
                    node.children
                        .iter()
                        .find(|child| child.kind == "ActionPanel")
                })
            });
        if let Some(panel) = panel {
            collect(panel, &mut result);
        }
        result
    }

    pub fn action_message(&self, action: &Node) -> Message {
        if let Some(callback) = action.callback("onAction") {
            Message::ExtensionInvoke(
                callback,
                if action.kind == "Action.SubmitForm" {
                    vec![json!(self.fields)]
                } else {
                    vec![]
                },
            )
        } else {
            Message::Noop
        }
    }

    pub fn shortcut(
        &self,
        selected: Option<&str>,
        key: &Key,
        modifiers: Modifiers,
    ) -> Option<&Node> {
        self.actions(selected).into_iter().find(|action| {
            let shortcut = &action.props["shortcut"];
            let expected = shortcut["key"].as_str().unwrap_or("").to_lowercase();
            let key_matches = match key.as_ref() {
                Key::Character(value) => value.to_lowercase() == expected,
                Key::Named(Named::Enter) => expected == "return",
                Key::Named(Named::Backspace) => expected == "backspace" || expected == "delete",
                Key::Named(Named::Delete) => expected == "deleteforward",
                _ => false,
            };
            let has = |name| {
                shortcut["modifiers"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|v| v == name))
            };
            key_matches
                && modifiers.control() == (has("cmd") || has("ctrl"))
                && modifiers.alt() == has("opt")
                && modifiers.shift() == has("shift")
                && !modifiers.logo()
        })
    }

    pub fn grid_columns(&self) -> usize {
        self.root()
            .filter(|node| node.kind == "Grid")
            .map_or(0, |root| {
                root.props["columns"]
                    .as_u64()
                    .unwrap_or(match root.text("itemSize") {
                        "small" => 8,
                        "large" => 3,
                        _ => 5,
                    })
                    .clamp(1, 8) as usize
            })
    }

    fn section_columns(&self, section: Option<&Node>) -> usize {
        section
            .and_then(|node| node.props["columns"].as_u64())
            .map(|value| value.clamp(1, 8) as usize)
            .unwrap_or_else(|| self.grid_columns())
    }

    pub fn grid_rows(&self, results: &[Entry]) -> Vec<Vec<usize>> {
        if self.grid_columns() == 0 {
            return vec![];
        }
        let mut rows: Vec<Vec<usize>> = Vec::new();
        let mut previous_section = None;
        for (index, entry) in results.iter().enumerate() {
            let section = self.section(entry);
            let id = section.map(|node| node.id.as_str());
            if rows
                .last()
                .is_none_or(|row| row.len() == self.section_columns(section))
                || id != previous_section
            {
                rows.push(Vec::new());
            }
            rows.last_mut().unwrap().push(index);
            previous_section = id;
        }
        rows
    }

    pub fn grid_move(&self, results: &[Entry], selected: usize, delta: i32) -> usize {
        let rows = self.grid_rows(results);
        let Some((row, column)) = rows.iter().enumerate().find_map(|(row, indices)| {
            indices
                .iter()
                .position(|index| *index == selected)
                .map(|column| (row, column))
        }) else {
            return selected;
        };
        let next = (row as i32 + delta).rem_euclid(rows.len() as i32) as usize;
        rows[next][column.min(rows[next].len() - 1)]
    }

    pub fn grid_offset(&self, results: &[Entry], selected: usize) -> f32 {
        let mut y: f32 = 0.;
        let mut previous_section = None;
        for row in self.grid_rows(results) {
            let section = self.section(&results[row[0]]);
            let id = section.map(|node| node.id.as_str());
            if id != previous_section && section.is_some() {
                y += 30.;
            }
            if row.contains(&selected) {
                return (y - 100.).max(0.);
            }
            y += 140.;
            previous_section = id;
        }
        0.
    }

    pub fn selection_message(&self, selected: Option<&Entry>) -> Option<Message> {
        let root = self.root()?;

        let callback = root.callback("onSelectionChange")?;
        let node =
            selected.and_then(|entry| self.find(entry.id.trim_start_matches("extension-item:")));
        Some(Message::ExtensionInvoke(
            callback,
            vec![node.map_or(Value::Null, |node| {
                json!(if node.text("id").is_empty() {
                    &node.id
                } else {
                    node.text("id")
                })
            })],
        ))
    }

    pub fn selected_detail(&self, selected: Option<&Entry>) -> Option<&Node> {
        if self.root()?.props["isShowingDetail"] != true {
            return None;
        }
        let node = self.find(selected?.id.trim_start_matches("extension-item:"))?;
        node.children.iter().find(|node| node.kind == "Detail")
    }

    pub fn section(&self, entry: &Entry) -> Option<&Node> {
        let id = entry.id.trim_start_matches("extension-item:");
        self.nodes.iter().flat_map(Node::descendants).find(|node| {
            matches!(node.kind.as_str(), "List.Section" | "Grid.Section")
                && node.descendants().iter().any(|child| child.id == id)
        })
    }

    pub fn accessory(&self, entry: &Entry) -> String {
        let Some(node) = self.find(entry.id.trim_start_matches("extension-item:")) else {
            return String::new();
        };
        node.props["accessories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                item["text"]
                    .as_str()
                    .or(item["text"]["value"].as_str())
                    .or(item["tag"].as_str())
                    .or(item["tag"]["value"].as_str())
                    .or(item["date"].as_str())
            })
            .map(|value| value.chars().take(24).collect::<String>())
            .collect::<Vec<_>>()
            .join(" · ")
    }

    pub fn search_accessory(&self) -> Option<Element<'_, Message>> {
        let node = self
            .root()?
            .children
            .iter()
            .find(|node| node.kind == "List.Dropdown")?;
        let items: Vec<(String, String)> = node
            .descendants()
            .iter()
            .filter(|node| node.kind == "List.Dropdown.Item")
            .map(|node| (node.text("title").into(), node.text("value").into()))
            .collect();
        let titles: Vec<_> = items.iter().map(|(title, _)| title.clone()).collect();
        let id = format!("dropdown:{}", node.id);
        let current = node.props["value"]
            .as_str()
            .or_else(|| self.fields.get(&id).and_then(Value::as_str))
            .unwrap_or(node.text("defaultValue"));
        let selected = items
            .iter()
            .find(|(_, value)| value == current)
            .or_else(|| {
                items
                    .iter()
                    .find(|(_, value)| value == node.text("defaultValue"))
            })
            .or_else(|| items.first())
            .map(|(title, _)| title.clone());
        let callback = node.callback("onChange")?;
        Some(
            widget::pick_list(titles, selected, move |title| {
                let value = items
                    .iter()
                    .find(|(name, _)| name == &title)
                    .map(|(_, value)| value.clone())
                    .unwrap_or_default();
                Message::ExtensionField(id.clone(), json!(value), Some(callback.clone()))
            })
            .into(),
        )
    }

    pub fn content<'a>(
        &'a self,
        colors: Colors,
        results: &'a [Entry],
        selected: usize,
    ) -> Option<Element<'a, Message>> {
        let root = self.root()?;
        if matches!(root.kind.as_str(), "List" | "Grid")
            && results.is_empty()
            && root.props["isLoading"] != true
        {
            let empty = root
                .descendants()
                .into_iter()
                .find(|node| node.kind == "List.EmptyView");
            let title = empty
                .map(|node| node.text("title"))
                .filter(|title| !title.is_empty())
                .unwrap_or("No results");
            let description = empty.map(|node| node.text("description")).unwrap_or("");
            return Some(
                container(
                    column![
                        text(title).size(20),
                        text(description).size(14).color(colors.muted)
                    ]
                    .spacing(12)
                    .align_x(iced::Alignment::Center),
                )
                .center(Fill)
                .into(),
            );
        }
        match root.kind.as_str() {
            "Form" => Some(
                scrollable(self.form(root, colors))
                    .id("extension-form")
                    .height(Fill)
                    .into(),
            ),
            "Detail" => Some(scrollable(self.detail(root, colors)).height(Fill).into()),
            "Grid" => {
                let mut grid = column![].spacing(8).padding(14);
                let mut previous_section = None;
                for indices in self.grid_rows(results) {
                    let section = self.section(&results[indices[0]]);
                    let columns = self.section_columns(section);
                    let section_id = section.map(|node| node.id.as_str());
                    if section_id != previous_section
                        && let Some(section) = section
                    {
                        grid = grid.push(
                            row![
                                text(section.text("title")).size(13),
                                text(section.text("subtitle")).size(12).color(colors.muted)
                            ]
                            .spacing(12)
                            .height(22),
                        );
                    }
                    previous_section = section_id;
                    let mut cells = row![].spacing(8);
                    for index in indices.iter().copied() {
                        let entry = &results[index];
                        let Some(item) = self.find(entry.id.trim_start_matches("extension-item:"))
                        else {
                            continue;
                        };
                        let selected = selected == index;
                        let property = |name: &str| {
                            section
                                .and_then(|node| node.props.get(name))
                                .or_else(|| root.props.get(name))
                        };
                        let ratio = match property("aspectRatio")
                            .and_then(Value::as_str)
                            .unwrap_or("1")
                        {
                            "3/2" => 1.5,
                            "2/3" => 2. / 3.,
                            "4/3" => 4. / 3.,
                            "3/4" => 0.75,
                            "16/9" => 16. / 9.,
                            "9/16" => 9. / 16.,
                            _ => 1.,
                        };
                        let inset =
                            match property("inset").and_then(Value::as_str).unwrap_or("zero") {
                                "sm" => 4.,
                                "md" => 8.,
                                "lg" => 16.,
                                _ => 0.,
                            };
                        let fit = if property("fit").and_then(Value::as_str) == Some("fill") {
                            iced::ContentFit::Cover
                        } else {
                            iced::ContentFit::Contain
                        };
                        let preview = super::extension_image::view(
                            &item.props["content"],
                            (70. - inset * 2.) * ratio,
                            70. - inset * 2.,
                            fit,
                            colors,
                        );
                        let label = column![
                            container(preview).center_x(Fill).center_y(70),
                            text(item.text("title")).size(14),
                            text(item.text("subtitle")).size(11).color(colors.muted)
                        ]
                        .spacing(8);
                        let cell = button(container(label).center(Fill))
                            .height(132)
                            .width(Fill)
                            .on_press(Message::Activate(index))
                            .style(move |_, status| colors.row(selected, status));
                        cells = cells.push(cell);
                    }
                    for _ in indices.len()..columns {
                        cells = cells.push(widget::Space::new().width(Fill));
                    }
                    grid = grid.push(cells);
                }
                Some(scrollable(grid).id("results").height(Fill).into())
            }
            _ => None,
        }
    }

    pub fn detail(&self, root: &Node, colors: Colors) -> Element<'_, Message> {
        let mut body = column![].spacing(14).padding(18);
        if let Some(markdown) = self.markdown.get(&root.id) {
            body = body.push(widget::markdown::view(markdown, colors.theme()).map(Message::Url));
        }
        for node in root
            .descendants()
            .into_iter()
            .filter(|n| n.kind.starts_with("Detail.Metadata."))
        {
            if node.kind == "Detail.Metadata.Separator" {
                body = body.push(widget::rule::horizontal(1));
            } else if node.kind == "Detail.Metadata.Link" {
                body = body.push(
                    button(text(format!(
                        "{}  {}",
                        node.text("title"),
                        node.text("text")
                    )))
                    .on_press(Message::Url(node.text("target").into())),
                );
            } else {
                body = body.push(
                    row![
                        text(node.text("title").to_string())
                            .size(12)
                            .color(colors.muted),
                        text(node.text("text").to_string()).size(13)
                    ]
                    .spacing(12),
                );
            }
        }
        body.into()
    }

    fn form(&self, root: &Node, colors: Colors) -> Element<'_, Message> {
        let mut body = column![].spacing(14).padding(18);
        for node in root
            .descendants()
            .into_iter()
            .filter(|n| n.kind.starts_with("Form."))
        {
            let id = node.text("id").to_string();
            let value = self.fields.get(&id).cloned().unwrap_or(Value::Null);
            let callback = node.callback("onChange");
            let field: Option<Element<'_, Message>> = match node.kind.as_str() {
                "Form.TextField" | "Form.PasswordField" => {
                    let input = text_input(node.text("placeholder"), value.as_str().unwrap_or(""))
                        .id(widget::Id::from(format!("field:{id}")))
                        .on_input(move |value| {
                            Message::ExtensionField(id.clone(), json!(value), callback.clone())
                        })
                        .on_submit(Message::Submit)
                        .secure(node.kind == "Form.PasswordField")
                        .padding(10)
                        .size(14);
                    Some(input.into())
                }
                "Form.DatePicker" => Some(
                    row![
                        text_input("YYYY-MM-DD", value.as_str().unwrap_or(""))
                            .id(widget::Id::from(format!("field:{id}")))
                            .on_input({
                                let id = id.clone();
                                let callback = callback.clone();
                                move |value| {
                                    Message::ExtensionField(
                                        id.clone(),
                                        json!(value),
                                        callback.clone(),
                                    )
                                }
                            })
                            .padding(10),
                        button("Choose date…")
                            .on_press(Message::ExtensionDate(id.clone(), node.props.clone())),
                        button("Clear").on_press(Message::ExtensionField(
                            id,
                            Value::Null,
                            callback
                        ))
                    ]
                    .spacing(8)
                    .into(),
                ),
                "Form.TextArea" => self.editors.get(&id).map(|content| {
                    text_editor(content)
                        .id(widget::Id::from(format!("field:{id}")))
                        .on_action(move |action| {
                            Message::ExtensionEdit(id.clone(), action, callback.clone())
                        })
                        .height(130)
                        .padding(10)
                        .into()
                }),
                "Form.TagPicker" => {
                    let selected = value.as_array().cloned().unwrap_or_default();
                    let mut items = column![].spacing(6);
                    for (index, item) in node
                        .descendants()
                        .into_iter()
                        .filter(|item| item.kind == "Form.TagPicker.Item")
                        .enumerate()
                    {
                        let item_value = json!(item.text("value"));
                        let checked = selected.contains(&item_value);
                        let mut next = selected.clone();
                        if checked {
                            next.retain(|value| value != &item_value);
                        } else {
                            next.push(item_value);
                        }
                        let id = id.clone();
                        let callback = callback.clone();
                        items = items.push(
                            checkbox(checked)
                                .label(format!(
                                    "{}{}",
                                    if self.focused == id
                                        && self.tag_selection.get(&id).copied().unwrap_or(0)
                                            == index
                                    {
                                        "› "
                                    } else {
                                        ""
                                    },
                                    item.text("title")
                                ))
                                .on_toggle(move |_| {
                                    Message::ExtensionField(
                                        id.clone(),
                                        json!(next),
                                        callback.clone(),
                                    )
                                }),
                        );
                    }
                    Some(items.into())
                }
                "Form.FilePicker" => {
                    let label = value
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    Some(
                        column![
                            text(label).size(12),
                            row![
                                button("Choose…").on_press(Message::ExtensionPick(
                                    id.clone(),
                                    node.props.clone()
                                )),
                                button("Clear").on_press(Message::ExtensionField(
                                    id,
                                    json!([]),
                                    callback
                                ))
                            ]
                            .spacing(10)
                        ]
                        .spacing(6)
                        .into(),
                    )
                }
                "Form.Checkbox" => Some(
                    checkbox(value.as_bool().unwrap_or(false))
                        .label(node.text("label").to_string())
                        .on_toggle(move |value| {
                            Message::ExtensionField(id.clone(), json!(value), callback.clone())
                        })
                        .into(),
                ),
                "Form.Dropdown" => {
                    let items: Vec<(String, String)> = node
                        .descendants()
                        .iter()
                        .filter(|n| n.kind == "Form.Dropdown.Item")
                        .map(|n| (n.text("title").into(), n.text("value").into()))
                        .collect();
                    let titles: Vec<_> = items.iter().map(|(title, _)| title.clone()).collect();
                    let selected = items
                        .iter()
                        .find(|(_, v)| Some(v.as_str()) == value.as_str())
                        .map(|(title, _)| title.clone());
                    Some(
                        widget::pick_list(titles, selected, move |title| {
                            let value = items
                                .iter()
                                .find(|(t, _)| t == &title)
                                .map(|(_, v)| v.clone())
                                .unwrap_or_default();
                            Message::ExtensionField(id.clone(), json!(value), callback.clone())
                        })
                        .into(),
                    )
                }
                "Form.Description" => Some(text(node.text("text").to_string()).size(13).into()),
                "Form.Separator" => Some(widget::rule::horizontal(1).into()),
                _ => None,
            };
            if let Some(field) = field {
                if !node.text("title").is_empty() {
                    body = body.push(
                        text(node.text("title").to_string())
                            .size(12)
                            .color(colors.muted),
                    );
                }
                if node.text("id").is_empty() {
                    body = body.push(field);
                } else {
                    let focused = self.focused == node.text("id");
                    let field =
                        container(field)
                            .padding(2)
                            .style(move |_| widget::container::Style {
                                border: iced::Border {
                                    color: if focused {
                                        colors.accent
                                    } else {
                                        iced::Color::TRANSPARENT
                                    },
                                    width: 1.,
                                    radius: 0.into(),
                                },
                                ..Default::default()
                            });
                    body = body.push(super::form_field::wrap(
                        node.text("id").into(),
                        focused,
                        field.into(),
                    ));
                }
                if !node.text("error").is_empty() {
                    body = body.push(
                        text(node.text("error").to_string())
                            .size(12)
                            .color(colors.accent),
                    );
                }
            }
        }
        for action in self
            .panel_nodes(None, None)
            .into_iter()
            .filter(|n| n.kind == "Action" || n.kind == "Action.SubmitForm")
            .take(1)
        {
            body = body.push(
                button(text(action.text("title").to_string()))
                    .on_press(self.action_message(action)),
            );
        }
        body.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(value: &str) -> Vec<Node> {
        serde_json::from_value(json!([{"id":"page","type":"Form","props":{},"children":[{"id":"input","type":"Form.TextArea","props":{"id":"text","value":value},"children":[]}]}])).unwrap()
    }

    #[test]
    fn filtered_grid_navigation_follows_sections_and_partial_rows() {
        let mut view = ExtensionView::default();
        let item = |id: &str| json!({"id":id,"type":"Grid.Item","props":{"id":id,"title":id}});
        view.update(serde_json::from_value(json!([{"id":"grid","type":"Grid","props":{"columns":3},"children":[
            {"id":"first","type":"Grid.Section","props":{"title":"First","columns":2},"children":[item("alpha"),item("beta"),item("gamma")]},
            {"id":"second","type":"Grid.Section","props":{"title":"Second","columns":1},"children":[item("delta")]}
        ]}])).unwrap(), 0);
        let all = view.entries("");
        assert_eq!(view.grid_rows(&all), vec![vec![0, 1], vec![2], vec![3]]);
        assert_eq!(view.grid_move(&all, 1, 1), 2);
        assert_eq!(view.grid_move(&all, 2, 1), 3);
        assert_eq!(view.grid_move(&all, 0, -1), 3);
        let filtered = view.entries("ta");
        assert_eq!(view.grid_rows(&filtered), vec![vec![0], vec![1]]);
        assert_eq!(view.grid_move(&filtered, 0, 1), 1);
        assert!(view.grid_rows(&view.entries("missing")).is_empty());
    }

    #[test]
    fn delayed_react_updates_preserve_newer_native_edits() {
        let mut view = ExtensionView::default();
        view.update(form(""), 0);
        let first = view.edit_field("text", json!("a"));
        let latest = view.edit_field("text", json!("ab"));
        view.editors
            .insert("text".into(), text_editor::Content::with_text("ab"));
        view.update(form("a"), first);
        assert_eq!(view.fields["text"], "ab");
        assert_eq!(view.editors["text"].text(), "ab");
        view.update(form("AB"), latest);
        assert_eq!(view.fields["text"], "AB");
        assert_eq!(view.editors["text"].text(), "AB");
    }
}
