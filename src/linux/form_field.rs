use super::app::Message;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, overlay, renderer,
    widget::{Id, Operation, Tree, operate, operation},
};
use iced::{Element, Event, Length, Rectangle, Size, Vector, keyboard, mouse};

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

pub fn wrap<'a>(id: String, focused: bool, content: Element<'a, Message>) -> Element<'a, Message> {
    Element::new(Field {
        id,
        focused,
        content,
    })
}

struct Field<'a> {
    id: String,
    focused: bool,
    content: Element<'a, Message>,
}

impl Widget<Message, iced::Theme, iced::Renderer> for Field<'_> {
    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }
    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_ref(&self.content));
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
