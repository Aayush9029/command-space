use super::app::Message;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, overlay, renderer,
    widget::{Id, Operation, Tree, operate, operation, tree},
};
use iced::{Element, Event, Length, Rectangle, Size, Vector, keyboard, mouse};

mod rows;
pub use rows::column;

pub fn reveal(id: String) -> iced::Task<Message> {
    operate(LocateField {
        id: Id::from(format!("form-row:{id}")),
        field: None,
        viewport: None,
    })
    .then(|offset| iced::widget::operation::scroll_to("extension-form", offset))
}

struct LocateField {
    id: Id,
    field: Option<Rectangle>,
    viewport: Option<(Rectangle, Vector)>,
}

impl Operation<operation::scrollable::AbsoluteOffset> for LocateField {
    fn traverse(
        &mut self,
        operate: &mut dyn FnMut(&mut dyn Operation<operation::scrollable::AbsoluteOffset>),
    ) {
        operate(self);
    }

    fn container(&mut self, id: Option<&Id>, bounds: Rectangle) {
        if id == Some(&self.id) {
            self.field = Some(bounds);
        }
    }

    fn scrollable(
        &mut self,
        id: Option<&Id>,
        bounds: Rectangle,
        _content: Rectangle,
        translation: Vector,
        _state: &mut dyn operation::Scrollable,
    ) {
        if id == Some(&Id::from("extension-form")) {
            self.viewport = Some((bounds, translation));
        }
    }

    fn finish(&self) -> operation::Outcome<operation::scrollable::AbsoluteOffset> {
        let (Some(field), Some((viewport, translation))) = (self.field, self.viewport) else {
            return operation::Outcome::None;
        };
        let top = field.y - viewport.y;
        let bottom = top + field.height;
        let y = if top < translation.y || field.height > viewport.height {
            (top - 8.).max(0.)
        } else if bottom > translation.y + viewport.height {
            bottom - viewport.height + 8.
        } else {
            return operation::Outcome::None;
        };
        operation::Outcome::Some(operation::scrollable::AbsoluteOffset {
            x: translation.x,
            y,
        })
    }
}

pub fn wrap<'a>(
    id: String,
    focused: bool,
    enabled: bool,
    content: Element<'a, Message>,
) -> Element<'a, Message> {
    Element::new(Field {
        id,
        focused,
        enabled,
        content,
    })
}

struct Field<'a> {
    id: String,
    focused: bool,
    enabled: bool,
    content: Element<'a, Message>,
}

struct State {
    enabled: bool,
}

impl Widget<Message, iced::Theme, iced::Renderer> for Field<'_> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }
    fn state(&self) -> tree::State {
        tree::State::new(State {
            enabled: self.enabled,
        })
    }
    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }
    fn diff(&self, tree: &mut Tree) {
        let state = tree.state.downcast_mut::<State>();
        if state.enabled != self.enabled {
            state.enabled = self.enabled;
            tree.children = self.children();
        } else {
            tree.diff_children(std::slice::from_ref(&self.content));
        }
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
        if !self.enabled {
            return;
        }
        operation.container(
            Some(&Id::from(format!("form-row:{}", self.id))),
            layout.bounds(),
        );
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
        if !self.enabled {
            return;
        }
        if self.focused
            && matches!(
                event,
                Event::Keyboard(keyboard::Event::KeyPressed {
                    key: keyboard::Key::Named(keyboard::key::Named::Tab),
                    ..
                })
            )
        {
            shell.capture_event();
            return;
        }
        if matches!(
            event,
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
        ) && layout
            .bounds()
            .intersection(viewport)
            .is_some_and(|bounds| cursor.is_over(bounds))
        {
            shell.publish(Message::ExtensionFocus(self.id.clone()));
        }
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
        if !self.enabled {
            return mouse::Interaction::None;
        }
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
        if !self.enabled {
            return None;
        }
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
    use iced::{Font, Pixels, widget::text_input};

    type InputState = text_input::State<<iced::Renderer as text::Renderer>::Paragraph>;

    struct TextField {
        field: Element<'static, Message>,
        tree: Tree,
        renderer: iced::Renderer,
        node: layout::Node,
    }

    impl TextField {
        fn new(enabled: bool) -> Self {
            let mut field = Self::element(enabled);
            let mut tree = Tree::new(&field);
            let renderer = iced::Renderer::new(Font::DEFAULT, Pixels(14.));
            let node = field.as_widget_mut().layout(
                &mut tree,
                &renderer,
                &layout::Limits::new(Size::ZERO, Size::new(240., 60.)),
            );
            Self {
                field,
                tree,
                renderer,
                node,
            }
        }

        fn element(enabled: bool) -> Element<'static, Message> {
            wrap(
                "name".into(),
                false,
                enabled,
                text_input("Name", "")
                    .id(Id::from("field:name"))
                    .on_input(|value| {
                        Message::ExtensionField(
                            "name".into(),
                            serde_json::json!(value),
                            Some("changed".into()),
                        )
                    })
                    .into(),
            )
        }

        fn rebuild(&mut self, enabled: bool) {
            self.field = Self::element(enabled);
            self.tree.diff(&self.field);
            self.node = self.field.as_widget_mut().layout(
                &mut self.tree,
                &self.renderer,
                &layout::Limits::new(Size::ZERO, Size::new(240., 60.)),
            );
        }

        fn update(&mut self, event: Event) -> Vec<Message> {
            let mut messages = Vec::new();
            let bounds = self.node.bounds();
            self.field.as_widget_mut().update(
                &mut self.tree,
                &event,
                Layout::new(&self.node),
                mouse::Cursor::Available(bounds.center()),
                &self.renderer,
                &mut clipboard::Null,
                &mut Shell::new(&mut messages),
                &bounds,
            );
            messages
        }

        fn click(&mut self) -> Vec<Message> {
            let messages = self.update(Event::Mouse(mouse::Event::ButtonPressed(
                mouse::Button::Left,
            )));
            assert!(
                self.update(Event::Mouse(mouse::Event::ButtonReleased(
                    mouse::Button::Left,
                )))
                .is_empty()
            );
            messages
        }

        fn type_a(&mut self) -> Vec<Message> {
            self.update(Event::Keyboard(keyboard::Event::KeyPressed {
                key: keyboard::Key::Character("a".into()),
                modified_key: keyboard::Key::Character("a".into()),
                physical_key: keyboard::key::Physical::Code(keyboard::key::Code::KeyA),
                location: keyboard::Location::Standard,
                modifiers: keyboard::Modifiers::empty(),
                text: Some("a".into()),
                repeat: false,
            }))
        }

        fn is_focused(&self) -> bool {
            self.tree.children[0]
                .state
                .downcast_ref::<InputState>()
                .is_focused()
        }

        fn focus(&mut self) {
            self.field.as_widget_mut().operate(
                &mut self.tree,
                Layout::new(&self.node),
                &self.renderer,
                &mut operation::focusable::focus::<()>(Id::from("field:name")),
            );
        }
    }

    #[test]
    fn disabled_text_field_rejects_mouse_focus_and_keyboard_input() {
        let mut field = TextField::new(false);
        assert!(field.click().is_empty());
        assert!(!field.is_focused());
        assert!(field.type_a().is_empty());

        let bounds = field.node.bounds();
        assert_eq!(
            field.field.as_widget().mouse_interaction(
                &field.tree,
                Layout::new(&field.node),
                mouse::Cursor::Available(bounds.center()),
                &bounds,
                &field.renderer,
            ),
            mouse::Interaction::None,
        );
    }

    #[test]
    fn queued_focus_operation_cannot_refocus_a_disabled_text_field() {
        let mut field = TextField::new(true);
        field.focus();
        assert!(field.is_focused());

        field.rebuild(false);
        assert!(!field.is_focused());
        field.focus();
        assert!(!field.is_focused());
        assert!(field.type_a().is_empty());

        field.rebuild(true);
        assert!(!field.is_focused());
        field.focus();
        assert!(field.is_focused());
    }

    #[test]
    fn disabling_a_focused_text_field_clears_native_focus_until_clicked_again() {
        let mut field = TextField::new(true);
        assert!(matches!(
            field.click().as_slice(),
            [Message::ExtensionFocus(id)] if id == "name"
        ));
        assert!(field.is_focused());

        field.rebuild(true);
        assert!(field.is_focused());
        assert!(matches!(
            field.type_a().as_slice(),
            [Message::ExtensionField(id, value, Some(callback))]
                if id == "name" && value == "a" && callback == "changed"
        ));

        field.rebuild(false);
        assert!(!field.is_focused());
        assert!(field.type_a().is_empty());
        assert!(field.click().is_empty());
        assert!(!field.is_focused());

        field.rebuild(true);
        assert!(!field.is_focused());
        assert!(field.type_a().is_empty());
        assert!(matches!(
            field.click().as_slice(),
            [Message::ExtensionFocus(id)] if id == "name"
        ));
        assert!(field.is_focused());
        assert!(matches!(
            field.type_a().as_slice(),
            [Message::ExtensionField(id, value, Some(callback))]
                if id == "name" && value == "a" && callback == "changed"
        ));
    }
}
