use super::Message;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, overlay, renderer,
    widget::{Operation, Tree, tree},
};
use iced::{Element, Event, Length, Rectangle, Size, Vector, mouse, widget::Column};
use std::collections::HashMap;

pub fn column<'a>(rows: Vec<(String, Element<'a, Message>)>) -> Element<'a, Message> {
    let (keys, children): (Vec<_>, Vec<_>) = rows.into_iter().unzip();
    Element::new(Rows {
        keys,
        content: Column::with_children(children)
            .spacing(18)
            .padding(24)
            .into(),
    })
}

struct Rows<'a> {
    keys: Vec<String>,
    content: Element<'a, Message>,
}

struct State {
    keys: Vec<String>,
}

impl Widget<Message, iced::Theme, iced::Renderer> for Rows<'_> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State {
            keys: self.keys.clone(),
        })
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        let state = tree.state.downcast_mut::<State>();
        if state.keys != self.keys {
            let mut previous: HashMap<_, _> = std::mem::take(&mut state.keys)
                .into_iter()
                .zip(std::mem::take(&mut tree.children[0].children))
                .collect();
            tree.children[0].children = self
                .keys
                .iter()
                .map(|key| previous.remove(key).unwrap_or_else(Tree::empty))
                .collect();
            state.keys.clone_from(&self.keys);
        }
        tree.children[0].diff(&self.content);
    }

    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }

    fn layout(
        &mut self,
        tree: &mut Tree,
        renderer: &iced::Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        self.content
            .as_widget_mut()
            .layout(&mut tree.children[0], renderer, limits)
    }

    fn operate(
        &mut self,
        tree: &mut Tree,
        layout: Layout<'_>,
        renderer: &iced::Renderer,
        operation: &mut dyn Operation,
    ) {
        self.content
            .as_widget_mut()
            .operate(&mut tree.children[0], layout, renderer, operation);
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &iced::Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        self.content.as_widget_mut().update(
            &mut tree.children[0],
            event,
            layout,
            cursor,
            renderer,
            clipboard,
            shell,
            viewport,
        );
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut iced::Renderer,
        theme: &iced::Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.as_widget().draw(
            &tree.children[0],
            renderer,
            theme,
            style,
            layout,
            cursor,
            viewport,
        );
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &iced::Renderer,
    ) -> mouse::Interaction {
        self.content.as_widget().mouse_interaction(
            &tree.children[0],
            layout,
            cursor,
            viewport,
            renderer,
        )
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout<'b>,
        renderer: &iced::Renderer,
        viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'b, Message, iced::Theme, iced::Renderer>> {
        self.content.as_widget_mut().overlay(
            &mut tree.children[0],
            layout,
            renderer,
            viewport,
            translation,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::advanced::{clipboard, text};
    use iced::{Font, Pixels, keyboard, widget::text_input};

    type InputState = text_input::State<<iced::Renderer as text::Renderer>::Paragraph>;

    struct Form {
        content: Element<'static, Message>,
        tree: Tree,
        renderer: iced::Renderer,
        node: layout::Node,
    }

    impl Form {
        fn new(rows: &[(&str, &str)]) -> Self {
            let mut content = Self::element(rows);
            let mut tree = Tree::new(&content);
            let renderer = iced::Renderer::new(Font::DEFAULT, Pixels(14.));
            let node = content.as_widget_mut().layout(
                &mut tree,
                &renderer,
                &layout::Limits::new(Size::ZERO, Size::new(360., 480.)),
            );
            Self {
                content,
                tree,
                renderer,
                node,
            }
        }

        fn element(rows: &[(&str, &str)]) -> Element<'static, Message> {
            column(
                rows.iter()
                    .map(|(key, id)| {
                        let key = String::from(*key);
                        let id = String::from(*id);
                        let callback = key.clone();
                        let field_id = id.clone();
                        (
                            key,
                            super::super::wrap(
                                id,
                                false,
                                true,
                                text_input("Value", "")
                                    .on_input(move |value| {
                                        Message::ExtensionField(
                                            field_id.clone(),
                                            serde_json::json!(value),
                                            Some(callback.clone()),
                                        )
                                    })
                                    .into(),
                            ),
                        )
                    })
                    .collect(),
            )
        }

        fn rebuild(&mut self, rows: &[(&str, &str)]) {
            self.content = Self::element(rows);
            self.tree.diff(&self.content);
            self.node = self.content.as_widget_mut().layout(
                &mut self.tree,
                &self.renderer,
                &layout::Limits::new(Size::ZERO, Size::new(360., 480.)),
            );
        }

        fn update(&mut self, event: Event, cursor: mouse::Cursor) -> Vec<Message> {
            let mut messages = Vec::new();
            self.content.as_widget_mut().update(
                &mut self.tree,
                &event,
                Layout::new(&self.node),
                cursor,
                &self.renderer,
                &mut clipboard::Null,
                &mut Shell::new(&mut messages),
                &self.node.bounds(),
            );
            messages
        }

        fn click(&mut self, index: usize) -> Vec<Message> {
            let bounds = Layout::new(&self.node)
                .children()
                .nth(index)
                .unwrap()
                .bounds();
            let cursor = mouse::Cursor::Available(bounds.center());
            let messages = self.update(
                Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
                cursor,
            );
            assert!(
                self.update(
                    Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)),
                    cursor,
                )
                .is_empty()
            );
            messages
        }

        fn type_a(&mut self) -> Vec<Message> {
            self.update(
                Event::Keyboard(keyboard::Event::KeyPressed {
                    key: keyboard::Key::Character("a".into()),
                    modified_key: keyboard::Key::Character("a".into()),
                    physical_key: keyboard::key::Physical::Code(keyboard::key::Code::KeyA),
                    location: keyboard::Location::Standard,
                    modifiers: keyboard::Modifiers::empty(),
                    text: Some("a".into()),
                    repeat: false,
                }),
                mouse::Cursor::Unavailable,
            )
        }

        fn focus_states(&self) -> Vec<bool> {
            self.tree.children[0]
                .children
                .iter()
                .map(|field| {
                    field.children[0]
                        .state
                        .downcast_ref::<InputState>()
                        .is_focused()
                })
                .collect()
        }
    }

    #[test]
    fn reordered_form_rows_keep_focus_on_the_same_node() {
        let mut form = Form::new(&[("node-a", "a"), ("node-b", "b"), ("node-c", "c")]);
        assert!(matches!(
            form.click(1).as_slice(),
            [Message::ExtensionFocus(id)] if id == "b"
        ));
        assert_eq!(form.focus_states(), [false, true, false]);

        form.rebuild(&[("node-b", "b"), ("node-c", "c"), ("node-a", "a")]);
        assert_eq!(form.focus_states(), [true, false, false]);
        assert!(matches!(
            form.type_a().as_slice(),
            [Message::ExtensionField(id, value, Some(callback))]
                if id == "b" && value == "a" && callback == "node-b"
        ));
    }

    #[test]
    fn removing_preceding_rows_preserves_focus_on_the_surviving_node() {
        let mut form = Form::new(&[("node-a", "a"), ("node-b", "b"), ("node-c", "c")]);
        form.click(1);
        assert_eq!(form.focus_states(), [false, true, false]);

        form.rebuild(&[("node-b", "b"), ("node-c", "c")]);
        assert_eq!(form.focus_states(), [true, false]);
        assert!(matches!(
            form.type_a().as_slice(),
            [Message::ExtensionField(id, value, Some(callback))]
                if id == "b" && value == "a" && callback == "node-b"
        ));
    }

    #[test]
    fn replacing_a_node_with_the_same_field_id_does_not_inherit_focus() {
        let mut form = Form::new(&[("old-node", "name")]);
        form.click(0);
        assert_eq!(form.focus_states(), [true]);

        form.rebuild(&[("new-node", "name")]);
        assert_eq!(form.focus_states(), [false]);
        assert!(form.type_a().is_empty());
        assert!(matches!(
            form.click(0).as_slice(),
            [Message::ExtensionFocus(id)] if id == "name"
        ));
        assert!(matches!(
            form.type_a().as_slice(),
            [Message::ExtensionField(id, value, Some(callback))]
                if id == "name" && value == "a" && callback == "new-node"
        ));
    }

    #[test]
    fn removing_the_focused_node_does_not_transfer_focus_to_its_neighbor() {
        let mut form = Form::new(&[("node-a", "a"), ("node-b", "b"), ("node-c", "c")]);
        form.click(1);
        assert_eq!(form.focus_states(), [false, true, false]);

        form.rebuild(&[("node-a", "a"), ("node-c", "c")]);
        assert_eq!(form.focus_states(), [false, false]);
        assert!(form.type_a().is_empty());
    }
}
