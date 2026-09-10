use super::app::Message;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, overlay, renderer,
    widget::{Id, Operation, Tree, operate, operation},
};
use iced::{Element, Event, Length, Rectangle, Size, Vector, keyboard, mouse};

pub fn wrap<'a>(
    id: impl Into<Id>,
    content: impl Into<Element<'a, Message>>,
    action: impl Fn(&keyboard::Key) -> Option<Message> + 'a,
) -> Element<'a, Message> {
    Element::new(Control {
        id: id.into(),
        content: content.into(),
        action: Box::new(action),
    })
}

pub fn activates(key: &keyboard::Key) -> bool {
    matches!(
        key,
        keyboard::Key::Named(keyboard::key::Named::Enter | keyboard::key::Named::Space)
    ) || key == &keyboard::Key::Character(" ".into())
}

#[derive(Default)]
struct State {
    focused: bool,
}
impl operation::Focusable for State {
    fn is_focused(&self) -> bool {
        self.focused
    }
    fn focus(&mut self) {
        self.focused = true;
    }
    fn unfocus(&mut self) {
        self.focused = false;
    }
}

pub fn reveal(scroll: &'static str) -> iced::Task<Message> {
    operate(Reveal {
        scroll: Id::from(scroll),
        active: None,
        pending: None,
        target: None,
    })
    .then(move |offset| iced::widget::operation::scroll_to(scroll, offset))
}

struct Reveal {
    scroll: Id,
    active: Option<(Rectangle, Vector)>,
    pending: Option<(Rectangle, Vector)>,
    target: Option<(Rectangle, Rectangle, Vector)>,
}
impl Operation<operation::scrollable::AbsoluteOffset> for Reveal {
    fn traverse(
        &mut self,
        operate: &mut dyn FnMut(&mut dyn Operation<operation::scrollable::AbsoluteOffset>),
    ) {
        let previous = self.active;
        if let Some(pending) = self.pending.take() {
            self.active = Some(pending);
        }
        operate(self);
        self.active = previous;
    }
    fn scrollable(
        &mut self,
        id: Option<&Id>,
        bounds: Rectangle,
        _content: Rectangle,
        translation: Vector,
        _state: &mut dyn operation::Scrollable,
    ) {
        if id == Some(&self.scroll) {
            self.pending = Some((bounds, translation));
        }
    }
    fn focusable(
        &mut self,
        _id: Option<&Id>,
        bounds: Rectangle,
        state: &mut dyn operation::Focusable,
    ) {
        if state.is_focused()
            && let Some((viewport, translation)) = self.active
        {
            self.target = Some((bounds, viewport, translation));
        }
    }
    fn finish(&self) -> operation::Outcome<operation::scrollable::AbsoluteOffset> {
        let Some((field, viewport, translation)) = self.target else {
            return operation::Outcome::None;
        };
        let top = field.y - viewport.y;
        let bottom = top + field.height;
        let y = if top < translation.y {
            (top - 24.).max(0.)
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

type KeyAction<'a> = Box<dyn Fn(&keyboard::Key) -> Option<Message> + 'a>;

struct Control<'a> {
    id: Id,
    action: KeyAction<'a>,
    content: Element<'a, Message>,
}

impl Widget<Message, iced::Theme, iced::Renderer> for Control<'_> {
    fn tag(&self) -> iced::advanced::widget::tree::Tag {
        iced::advanced::widget::tree::Tag::of::<State>()
    }
    fn state(&self) -> iced::advanced::widget::tree::State {
        iced::advanced::widget::tree::State::new(State::default())
    }
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
        operation.focusable(
            Some(&self.id),
            layout.bounds(),
            tree.state.downcast_mut::<State>(),
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
        if tree.state.downcast_ref::<State>().focused
            && let Event::Keyboard(keyboard::Event::KeyPressed { key, .. }) = event
            && let Some(message) = (self.action)(key)
        {
            shell.publish(message);
            shell.capture_event();
            return;
        }
        if matches!(
            event,
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
        ) && !cursor.is_over(layout.bounds())
        {
            tree.state.downcast_mut::<State>().focused = false;
        }
        if matches!(
            event,
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
        ) && layout
            .bounds()
            .intersection(viewport)
            .is_some_and(|bounds| cursor.is_over(bounds))
        {
            shell.publish(Message::WidgetFocus(self.id.clone()));
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
        if tree.state.downcast_ref::<State>().focused {
            use iced::advanced::Renderer as _;
            renderer.fill_quad(
                renderer::Quad {
                    bounds: layout.bounds(),
                    border: iced::Border {
                        color: style.text_color,
                        width: 1.,
                        radius: 0.into(),
                    },
                    ..Default::default()
                },
                iced::Color::TRANSPARENT,
            );
        }
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
