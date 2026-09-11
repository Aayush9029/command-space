use super::app::Message;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, overlay, renderer,
    widget::{Operation, Tree},
};
use iced::{Element, Event, Length, Rectangle, Size, Vector, keyboard, mouse};
use std::cell::Cell;

pub fn wrap<'a>(content: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    Element::new(KeyboardHandler {
        content: content.into(),
        shortcut: None,
    })
}

pub fn scope<'a>(
    content: impl Into<Element<'a, Message>>,
    shortcut: impl Fn(&keyboard::Key, keyboard::Modifiers) -> Option<Message> + 'a,
) -> Element<'a, Message> {
    Element::new(KeyboardHandler {
        content: content.into(),
        shortcut: Some(Box::new(shortcut)),
    })
}

type Shortcut<'a> = Box<dyn Fn(&keyboard::Key, keyboard::Modifiers) -> Option<Message> + 'a>;

struct KeyboardHandler<'a> {
    content: Element<'a, Message>,
    shortcut: Option<Shortcut<'a>>,
}

impl Widget<Message, iced::Theme, iced::Renderer> for KeyboardHandler<'_> {
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
        if let Some(shortcut) = &self.shortcut
            && let Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) = event
        {
            if let Some(message) = shortcut(key, *modifiers) {
                shell.publish(message);
                shell.capture_event();
                return;
            }
            if *key == keyboard::Key::Named(keyboard::key::Named::Escape) {
                // A captured Escape can mean either menu dismissal or text-input unfocus.
                // Resolve its meaning during this event, before application messages queue.
                let mut messages = Vec::new();
                let mut child_shell = Shell::new(&mut messages);
                self.content.as_widget_mut().update(
                    &mut tree.children[0],
                    event,
                    layout,
                    cursor,
                    renderer,
                    clipboard,
                    &mut child_shell,
                    viewport,
                );
                let dismissed = Cell::new(false);
                shell.merge(child_shell, |message| match message {
                    Message::DropdownDismissed => {
                        dismissed.set(true);
                        Message::Noop
                    }
                    message => message,
                });
                if !dismissed.get() {
                    shell.publish(Message::Back);
                }
                shell.capture_event();
                return;
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
            let captured = shell.is_event_captured();
            if *key != keyboard::Key::Named(keyboard::key::Named::Enter) || !captured {
                shell.publish(Message::Key(key.clone(), *modifiers, captured));
            }
            return;
        }
        if let Event::Keyboard(keyboard::Event::KeyPressed {
            key: keyboard::Key::Named(keyboard::key::Named::Escape),
            modifiers,
            ..
        }) = event
            && self
                .content
                .as_widget_mut()
                .overlay(
                    &mut tree.children[0],
                    layout,
                    renderer,
                    viewport,
                    Vector::ZERO,
                )
                .is_some()
        {
            // Iced exposes no close operation for its private pick-list menu state.
            tree.children[0] = Tree::new(&self.content);
            self.content.as_widget_mut().update(
                &mut tree.children[0],
                &Event::Keyboard(keyboard::Event::ModifiersChanged(*modifiers)),
                layout,
                cursor,
                renderer,
                clipboard,
                shell,
                viewport,
            );
            shell.invalidate_layout();
            shell.request_redraw();
            shell.capture_event();
            shell.publish(Message::DropdownDismissed);
            return;
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

#[cfg(test)]
mod tests;
