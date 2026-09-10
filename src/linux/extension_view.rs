use super::{
    app::Message,
    appearance::Colors,
    extensions::Node,
    model::{Action, Entry},
};
use iced::{
    Alignment, Background, Border, Color, Element,
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
    pagination_request: Option<(Vec<String>, bool, std::time::Instant)>,
}

impl ExtensionView {
    pub fn edit_field(&mut self, id: &str, value: Value) -> u64 {
        self.input_revision += 1;
        self.fields.insert(id.into(), value);
        self.pending_fields.insert(id.into(), self.input_revision);
        self.input_revision
    }

    pub fn update(&mut self, nodes: Vec<Node>, acknowledged_revision: u64) {
        if let Some((requested, saw_loading, _)) = &mut self.pagination_request {
            let identity = Self::page_identity(&nodes);
            let loading = nodes.first().is_some_and(|n| n.props["isLoading"] == true);
            if *requested != identity || (*saw_loading && !loading) {
                self.pagination_request = None;
            } else {
                *saw_loading |= loading;
            }
        }
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

    fn page_identity(nodes: &[Node]) -> Vec<String> {
        nodes
            .iter()
            .flat_map(Node::descendants)
            .filter(|n| matches!(n.kind.as_str(), "List" | "Grid" | "List.Item" | "Grid.Item"))
            .map(|n| format!("{}:{}:{}", n.id, n.text("id"), n.text("searchText")))
            .collect()
    }

    pub fn has_more(&self) -> bool {
        self.root().is_some_and(|root| {
            matches!(root.kind.as_str(), "List" | "Grid")
                && root.props["pagination"]["hasMore"] == true
        })
    }

    pub fn load_more(&mut self, retry: bool) -> Option<Message> {
        let root = self.root()?;
        if !self.has_more()
            || root.props["isLoading"] == true
            || self
                .pagination_request
                .as_ref()
                .is_some_and(|(_, _, started)| !retry || started.elapsed().as_secs() < 10)
        {
            return None;
        }
        let callback = root.props["pagination"]["onLoadMore"]["$callback"]
            .as_str()?
            .to_owned();
        self.pagination_request = Some((
            Self::page_identity(&self.nodes),
            false,
            std::time::Instant::now(),
        ));
        Some(Message::ExtensionInvoke(callback, vec![]))
    }

    pub fn pagination_footer(&self, colors: Colors) -> Element<'_, Message> {
        if !self.has_more() {
            return widget::Space::new().into();
        }
        let root = self.root().unwrap();
        let mut body = column![].spacing(8);
        if root.props["isLoading"] == true || self.pagination_request.is_some() {
            let count = root.props["pagination"]["pageSize"]
                .as_u64()
                .unwrap_or(1)
                .clamp(1, 50);
            for _ in 0..count {
                body = body.push(
                    container(
                        row![
                            container(widget::Space::new().width(22).height(22))
                                .style(move |_| skeleton_style(colors)),
                            container(widget::Space::new().width(160).height(10))
                                .style(move |_| skeleton_style(colors)),
                        ]
                        .spacing(12)
                        .align_y(Alignment::Center),
                    )
                    .padding([10, 14])
                    .height(48),
                );
            }
        }
        if root.props["isLoading"] != true
            && self
                .pagination_request
                .as_ref()
                .is_none_or(|(_, _, started)| started.elapsed().as_secs() >= 10)
        {
            body = body.push(
                button(text("Load more").size(13))
                    .padding([8, 12])
                    .style(move |_, status| control_style(colors, status))
                    .on_press(Message::ExtensionLoadMore(true)),
            );
        }
        body.into()
    }

    pub fn scrolled(viewport: scrollable::Viewport) -> Message {
        let offset = viewport.absolute_offset().y;
        if offset > 0. && viewport.content_bounds().height - viewport.bounds().height - offset < 64.
        {
            Message::ExtensionLoadMore(false)
        } else {
            Message::Noop
        }
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
                selected
                    .is_none()
                    .then(|| {
                        self.root()?
                            .children
                            .iter()
                            .find(|node| {
                                matches!(node.kind.as_str(), "List.EmptyView" | "Grid.EmptyView")
                            })?
                            .children
                            .iter()
                            .find(|node| node.kind == "ActionPanel")
                    })
                    .flatten()
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
        let next = if delta > 0 && self.has_more() {
            (row + delta as usize).min(rows.len() - 1)
        } else {
            (row as i32 + delta).rem_euclid(rows.len() as i32) as usize
        };
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

    pub fn accessories<'a>(&'a self, entry: &Entry, colors: Colors) -> Element<'a, Message> {
        let Some(node) = self.find(entry.id.trim_start_matches("extension-item:")) else {
            return widget::Space::new().into();
        };
        let mut accessories = row![].spacing(10).align_y(Alignment::Center);
        for item in node.props["accessories"].as_array().into_iter().flatten() {
            let mut content = row![].spacing(5).align_y(Alignment::Center);
            if !item["icon"].is_null() {
                content = content.push(super::extension_image::view(
                    &item["icon"],
                    16.,
                    16.,
                    iced::ContentFit::Contain,
                    colors,
                ));
            }
            let tagged = !item["tag"].is_null();
            let value = if tagged {
                &item["tag"]
            } else if !item["text"].is_null() {
                &item["text"]
            } else {
                &item["date"]
            };
            if let Some(value_text) = value.as_str().or(value["value"].as_str()) {
                let tint =
                    super::extension_image::color(&value["color"], colors).unwrap_or(colors.muted);
                let label = text(value_text.chars().take(24).collect::<String>())
                    .size(12)
                    .color(tint);
                if tagged {
                    content = content.push(container(label).padding([3, 6]).style(move |_| {
                        container::Style {
                            background: Some(colors.selection.into()),
                            border: Border {
                                radius: 3.into(),
                                ..Default::default()
                            },
                            ..Default::default()
                        }
                    }));
                } else {
                    content = content.push(label);
                }
            }
            let content: Element<'_, Message> = if let Some(tooltip) = item["tooltip"].as_str() {
                widget::tooltip(
                    content,
                    container(text(tooltip).size(12))
                        .padding([6, 8])
                        .style(move |_| tooltip_style(colors)),
                    widget::tooltip::Position::Top,
                )
                .into()
            } else {
                content.into()
            };
            accessories = accessories.push(content);
        }
        accessories.into()
    }

    pub fn panel_icon(
        &self,
        selected_id: Option<&str>,
        submenu: Option<&str>,
        query: &str,
        index: usize,
    ) -> Option<&Value> {
        self.panel_nodes(selected_id, submenu)
            .into_iter()
            .filter(|node| {
                let title = if node.kind == "ActionPanel.Submenu" {
                    format!("{}  ›", node.text("title"))
                } else {
                    node.text("title").to_owned()
                };
                title.to_lowercase().contains(&query.to_lowercase())
            })
            .nth(index)
            .map(|node| &node.props["icon"])
            .filter(|icon| !icon.is_null())
    }

    pub fn search_accessory(&self, colors: Colors) -> Option<Element<'_, Message>> {
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
            .padding([7, 10])
            .text_size(13)
            .style(move |_, status| select_style(colors, status))
            .menu_style(move |_| menu_style(colors))
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
                .find(|node| matches!(node.kind.as_str(), "List.EmptyView" | "Grid.EmptyView"));
            let title = empty
                .map(|node| node.text("title"))
                .filter(|title| !title.is_empty())
                .unwrap_or("No results");
            let description = empty.map(|node| node.text("description")).unwrap_or("");
            let mut content = column![].spacing(12).align_x(iced::Alignment::Center);
            if let Some(icon) = empty
                .map(|node| &node.props["icon"])
                .filter(|icon| !icon.is_null())
            {
                content = content.push(super::extension_image::view(
                    icon,
                    48.,
                    48.,
                    iced::ContentFit::Contain,
                    colors,
                ));
            }
            content = content.push(text(title).size(17));
            if !description.is_empty() {
                content = content.push(text(description).size(13).color(colors.muted));
            }
            return Some(
                container(content.push(self.pagination_footer(colors)))
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
                let mut grid = column![].spacing(8).padding([12, 16]);
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
                                text(section.text("title")).size(12).color(colors.muted),
                                text(section.text("subtitle")).size(12).color(colors.muted)
                            ]
                            .spacing(8)
                            .align_y(Alignment::Center)
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
                        let preview = widget::responsive(move |size| {
                            let width = (size.width - inset * 2.).max(1.);
                            let height = (size.height - inset * 2.).max(1.).min(width / ratio);
                            container(super::extension_image::view(
                                &item.props["content"],
                                height * ratio,
                                height,
                                fit,
                                colors,
                            ))
                            .center(Fill)
                            .into()
                        })
                        .height(74);
                        let mut label = column![preview].spacing(5).align_x(Alignment::Center);
                        if !item.text("title").is_empty() {
                            label = label.push(
                                text(item.text("title"))
                                    .size(13)
                                    .wrapping(text::Wrapping::None),
                            );
                        }
                        if !item.text("subtitle").is_empty() {
                            label = label.push(
                                text(item.text("subtitle"))
                                    .size(11)
                                    .color(colors.muted)
                                    .wrapping(text::Wrapping::None),
                            );
                        }
                        let cell = button(container(label).center(Fill))
                            .padding([7, 8])
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
                grid = grid.push(self.pagination_footer(colors));
                Some(
                    scrollable(grid)
                        .id("results")
                        .on_scroll(Self::scrolled)
                        .height(Fill)
                        .into(),
                )
            }
            _ => None,
        }
    }

    pub fn detail<'a>(&'a self, root: &'a Node, colors: Colors) -> Element<'a, Message> {
        let mut body = column![].spacing(18).padding(24);
        if let Some(markdown) = self.markdown.get(&root.id) {
            body = body.push(widget::markdown::view(markdown, colors.theme()).map(Message::Url));
        }
        let metadata = root
            .descendants()
            .into_iter()
            .find(|node| node.kind == "Detail.Metadata");
        if let Some(metadata) = metadata {
            if self.markdown.contains_key(&root.id) {
                body = body.push(widget::rule::horizontal(1).style(move |_| colors.divider()));
            }
            let mut rows = column![].spacing(12);
            for node in &metadata.children {
                let value: Element<'_, Message> = match node.kind.as_str() {
                    "Detail.Metadata.Separator" => {
                        rows =
                            rows.push(widget::rule::horizontal(1).style(move |_| colors.divider()));
                        continue;
                    }
                    "Detail.Metadata.Link" => button(
                        row![
                            text(node.text("text").to_owned()).size(13),
                            text("↗").size(13).color(colors.muted)
                        ]
                        .spacing(6)
                        .align_y(Alignment::Center),
                    )
                    .padding([3, 6])
                    .style(move |_, status| colors.row(false, status))
                    .on_press(Message::Url(node.text("target").into()))
                    .into(),
                    "Detail.Metadata.TagList" => {
                        let mut tags = row![].spacing(6);
                        for tag in &node.children {
                            if tag.kind != "Detail.Metadata.TagList.Item" {
                                continue;
                            }
                            let tint = super::extension_image::color(&tag.props["color"], colors)
                                .unwrap_or(colors.foreground);
                            let content = text(tag.text("text").to_owned()).size(12).color(tint);
                            let tag = button(content)
                                .padding([4, 8])
                                .style(move |_, status| control_style(colors, status))
                                .on_press(self.action_message(tag));
                            tags = tags.push(tag);
                        }
                        tags.into()
                    }
                    "Detail.Metadata.Label" => {
                        let mut content = row![].spacing(8).align_y(Alignment::Center);
                        if !node.props["icon"].is_null() {
                            content = content.push(super::extension_image::view(
                                &node.props["icon"],
                                16.,
                                16.,
                                iced::ContentFit::Contain,
                                colors,
                            ));
                        }
                        content
                            .push(text(node.text("text").to_owned()).size(13))
                            .into()
                    }
                    _ => continue,
                };
                rows = rows.push(
                    row![
                        container(
                            text(node.text("title").to_owned())
                                .size(12)
                                .color(colors.muted)
                        )
                        .width(120)
                        .padding([3, 0]),
                        container(value).width(Fill),
                    ]
                    .spacing(16)
                    .align_y(Alignment::Start),
                );
            }
            body = body.push(rows);
        }
        body.into()
    }

    fn form<'a>(&'a self, root: &'a Node, colors: Colors) -> Element<'a, Message> {
        let mut body = column![].spacing(18).padding(24);
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
                        .padding([9, 10])
                        .size(14)
                        .style(move |_, status| input_style(colors, status));
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
                            .on_submit(Message::Submit)
                            .size(14)
                            .padding([9, 10])
                            .style(move |_, status| input_style(colors, status)),
                        icon_button(
                            "󰃭",
                            "Choose date",
                            Message::ExtensionDate(id.clone(), node.props.clone()),
                            colors
                        ),
                        icon_button(
                            "󰅖",
                            "Clear date",
                            Message::ExtensionField(id, Value::Null, callback),
                            colors
                        ),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center)
                    .into(),
                ),
                "Form.TextArea" => self.editors.get(&id).map(|content| {
                    let height = node.props["height"]
                        .as_f64()
                        .filter(|value| value.is_finite())
                        .map(|value| value.clamp(96., 480.) as f32)
                        .unwrap_or(130.);
                    let mut editor = text_editor(content)
                        .id(widget::Id::from(format!("field:{id}")))
                        .on_action(move |action| {
                            Message::ExtensionEdit(id.clone(), action, callback.clone())
                        })
                        .height(height)
                        .placeholder(node.text("placeholder"))
                        .padding(10)
                        .size(14)
                        .style(move |_, status| text_editor::Style {
                            background: colors.background.into(),
                            border: field_border(
                                colors,
                                matches!(status, text_editor::Status::Focused { .. }),
                            ),
                            placeholder: colors.muted,
                            value: colors.foreground,
                            selection: colors.selection,
                        });
                    if node.text("fontFamily") == "monospace" {
                        editor = editor.font(iced::Font::with_name("JetBrainsMono Nerd Font"));
                    }
                    container(editor).clip(true).into()
                }),
                "Form.TagPicker" => {
                    let selected = value.as_array().cloned().unwrap_or_default();
                    let mut items = column![].spacing(3);
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
                        let active = self.focused == id
                            && self.tag_selection.get(&id).copied().unwrap_or(0) == index;
                        let id = id.clone();
                        let callback = callback.clone();
                        let control = checkbox(checked)
                            .label(item.text("title"))
                            .size(16)
                            .text_size(13)
                            .spacing(9)
                            .style(move |_, status| checkbox_style(colors, checked, status))
                            .on_toggle(move |_| {
                                Message::ExtensionField(id.clone(), json!(next), callback.clone())
                            });
                        items = items.push(container(control).width(Fill).padding([6, 8]).style(
                            move |_| container::Style {
                                background: active.then_some(colors.selection.into()),
                                border: Border {
                                    radius: 2.into(),
                                    ..Default::default()
                                },
                                ..Default::default()
                            },
                        ));
                    }
                    Some(items.into())
                }
                "Form.FilePicker" => {
                    let files = value.as_array().cloned().unwrap_or_default();
                    let mut content = column![].spacing(8);
                    for path in files.iter().filter_map(Value::as_str) {
                        let name = std::path::Path::new(path)
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(path)
                            .to_owned();
                        content = content.push(widget::tooltip(
                            row![
                                text("󰈔")
                                    .font(iced::Font::with_name("JetBrainsMono Nerd Font"))
                                    .size(16)
                                    .color(colors.muted),
                                text(name).size(13)
                            ]
                            .spacing(8)
                            .align_y(Alignment::Center),
                            container(text(path.to_owned()).size(12))
                                .padding([6, 8])
                                .style(move |_| tooltip_style(colors)),
                            widget::tooltip::Position::Top,
                        ));
                    }
                    let mut actions = row![
                        button(
                            text(if node.props["allowMultipleSelection"] == false {
                                "Choose file…"
                            } else {
                                "Choose files…"
                            })
                            .size(13)
                        )
                        .padding([8, 10])
                        .style(move |_, status| control_style(colors, status))
                        .on_press(Message::ExtensionPick(id.clone(), node.props.clone()))
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center);
                    if !files.is_empty() {
                        actions = actions.push(icon_button(
                            "󰅖",
                            "Clear files",
                            Message::ExtensionField(id, json!([]), callback),
                            colors,
                        ));
                    }
                    content = content.push(actions);
                    Some(content.into())
                }
                "Form.Checkbox" => {
                    let checked = value.as_bool().unwrap_or(false);
                    Some(
                        container(
                            checkbox(checked)
                                .label(node.text("label").to_string())
                                .size(16)
                                .text_size(13)
                                .spacing(9)
                                .style(move |_, status| checkbox_style(colors, checked, status))
                                .on_toggle(move |value| {
                                    Message::ExtensionField(
                                        id.clone(),
                                        json!(value),
                                        callback.clone(),
                                    )
                                }),
                        )
                        .padding([8, 0])
                        .into(),
                    )
                }
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
                        .width(Fill)
                        .padding([9, 10])
                        .text_size(14)
                        .style(move |_, status| select_style(colors, status))
                        .menu_style(move |_| menu_style(colors))
                        .into(),
                    )
                }
                "Form.Description" => Some(
                    text(node.text("text").to_string())
                        .size(13)
                        .color(colors.muted)
                        .into(),
                ),
                "Form.Separator" => Some(
                    widget::rule::horizontal(1)
                        .style(move |_| colors.divider())
                        .into(),
                ),
                _ => None,
            };
            if let Some(field) = field {
                if node.kind == "Form.Separator" {
                    body = body.push(field);
                    continue;
                }
                let field = if node.text("id").is_empty() {
                    field
                } else {
                    let focused = self.focused == node.text("id");
                    let field = container(field)
                        .padding(2)
                        .style(move |_| container::Style {
                            border: Border {
                                color: if focused {
                                    colors.muted
                                } else {
                                    Color::TRANSPARENT
                                },
                                width: 1.,
                                radius: 3.into(),
                            },
                            ..Default::default()
                        });
                    super::form_field::wrap(node.text("id").into(), focused, field.into())
                };
                let mut content = column![field].spacing(6).width(Fill);
                if !node.text("error").is_empty() {
                    content = content.push(
                        text(node.text("error").to_owned())
                            .size(12)
                            .color(Color::from_rgb8(237, 119, 119)),
                    );
                }
                if node.text("title").is_empty() {
                    body = body.push(content);
                } else {
                    let label = container(
                        text(node.text("title").to_owned())
                            .size(13)
                            .color(colors.muted),
                    )
                    .width(130)
                    .padding([10, 0]);
                    body = body.push(row![label, content].spacing(16).align_y(Alignment::Start));
                }
            }
        }
        body.into()
    }
}

fn field_border(colors: Colors, focused: bool) -> Border {
    Border {
        color: if focused {
            colors.muted
        } else {
            colors.border()
        },
        width: 1.,
        radius: 2.into(),
    }
}

fn input_style(colors: Colors, status: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: colors.background.into(),
        border: field_border(colors, matches!(status, text_input::Status::Focused { .. })),
        icon: colors.muted,
        placeholder: colors.muted,
        value: colors.foreground,
        selection: colors.selection,
    }
}

fn select_style(colors: Colors, status: widget::pick_list::Status) -> widget::pick_list::Style {
    widget::pick_list::Style {
        text_color: colors.foreground,
        placeholder_color: colors.muted,
        handle_color: colors.muted,
        background: colors.background.into(),
        border: field_border(
            colors,
            matches!(status, widget::pick_list::Status::Opened { .. }),
        ),
    }
}

fn menu_style(colors: Colors) -> widget::overlay::menu::Style {
    widget::overlay::menu::Style {
        background: colors.background.into(),
        border: field_border(colors, false),
        text_color: colors.foreground,
        selected_text_color: colors.foreground,
        selected_background: colors.selection.into(),
        shadow: Default::default(),
    }
}

fn checkbox_style(colors: Colors, checked: bool, status: checkbox::Status) -> checkbox::Style {
    checkbox::Style {
        background: Background::Color(if checked {
            colors.foreground
        } else {
            colors.background
        }),
        icon_color: colors.background,
        border: field_border(colors, matches!(status, checkbox::Status::Hovered { .. })),
        text_color: Some(colors.foreground),
    }
}

fn control_style(colors: Colors, status: button::Status) -> button::Style {
    let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some(
            if hover {
                colors.selection
            } else {
                colors.background
            }
            .into(),
        ),
        text_color: colors.foreground,
        border: field_border(colors, false),
        ..Default::default()
    }
}

fn skeleton_style(colors: Colors) -> container::Style {
    container::Style {
        background: Some(colors.selection.into()),
        border: Border {
            radius: 3.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn tooltip_style(colors: Colors) -> container::Style {
    container::Style {
        background: Some(colors.selection.into()),
        text_color: Some(colors.foreground),
        border: field_border(colors, false),
        ..Default::default()
    }
}

fn icon_button<'a>(
    icon: &'a str,
    label: &'a str,
    message: Message,
    colors: Colors,
) -> Element<'a, Message> {
    widget::tooltip(
        button(
            text(icon)
                .font(iced::Font::with_name("JetBrainsMono Nerd Font"))
                .size(16),
        )
        .padding([8, 9])
        .style(move |_, status| control_style(colors, status))
        .on_press(message),
        container(text(label).size(12))
            .padding([6, 8])
            .style(move |_| tooltip_style(colors)),
        widget::tooltip::Position::Top,
    )
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(value: &str) -> Vec<Node> {
        serde_json::from_value(json!([{"id":"page","type":"Form","props":{},"children":[{"id":"input","type":"Form.TextArea","props":{"id":"text","value":value},"children":[]}]}])).unwrap()
    }

    #[test]
    fn empty_view_actions_work_for_lists_and_grids() {
        for kind in ["List", "Grid"] {
            let mut view = ExtensionView::default();
            view.update(serde_json::from_value(json!([{
                "id": "root", "type": kind, "children": [{
                    "id": "empty", "type": format!("{kind}.EmptyView"), "children": [{
                        "id": "panel", "type": "ActionPanel", "children": [{
                            "id": "retry", "type": "Action", "props": {"title": "Retry", "onAction": {"$callback": "retry"}}
                        }]
                    }]
                }]
            }])).unwrap(), 0);
            assert_eq!(view.actions(None).len(), 1);
            assert!(
                matches!(view.action_message(view.actions(None)[0]), Message::ExtensionInvoke(callback, _) if callback == "retry")
            );
        }
    }

    #[test]
    fn pagination_deduplicates_requests_and_recovers_after_loading() {
        let mut view = ExtensionView::default();
        let page = |count: usize, loading: bool, more: bool| {
            serde_json::from_value(json!([{
            "id":"list","type":"List","props":{"isLoading":loading,"pagination":{"hasMore":more,"onLoadMore":{"$callback":"load"}}},
            "children": (0..count).map(|i| json!({"id":i.to_string(),"type":"List.Item","props":{"title":i.to_string()}})).collect::<Vec<_>>()
        }])).unwrap()
        };
        view.update(page(10, false, true), 0);
        assert!(matches!(
            view.load_more(false),
            Some(Message::ExtensionInvoke(_, _))
        ));
        assert!(view.load_more(false).is_none());
        assert!(view.load_more(true).is_none());
        view.update(page(10, true, true), 0);
        assert!(view.load_more(false).is_none());
        view.update(page(20, false, true), 0);
        assert!(view.load_more(false).is_some());
        view.update(page(20, true, true), 0);
        view.update(page(20, false, true), 0);
        assert!(view.load_more(false).is_some());
        view.update(page(30, false, false), 0);
        assert!(!view.has_more());
        assert!(view.load_more(true).is_none());
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
