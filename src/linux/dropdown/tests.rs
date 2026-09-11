use super::*;
use iced::advanced::{clipboard, layout, text, widget::Tree};
use iced::{Font, Pixels, Point, Size, event, keyboard, widget, window};

struct EventResult {
    messages: Vec<Message>,
    status: event::Status,
    layout_invalid: bool,
    redraw_request: window::RedrawRequest,
}

struct Dropdown {
    content: Element<'static, Message>,
    tree: Tree,
    renderer: iced::Renderer,
    node: layout::Node,
    viewport: Rectangle,
}

impl Dropdown {
    fn new() -> Self {
        Self::with_content(Self::pick_list())
    }

    fn scoped() -> Self {
        Self::with_content(scope(
            widget::column![
                widget::text_input("Search", "").on_input(|value| {
                    Message::ExtensionField("search".into(), serde_json::json!(value), None)
                }),
                Self::pick_list(),
            ]
            .spacing(12),
            |_, _| None,
        ))
    }

    fn keyboard_scope() -> Self {
        Self::with_content(scope(
            widget::column![
                widget::text_input("Search", "")
                    .on_input(Message::Query)
                    .on_submit(Message::Submit),
            ],
            |key, modifiers| {
                (matches!(key.as_ref(), keyboard::Key::Character("v"))
                    && modifiers.control()
                    && modifiers.shift())
                .then_some(Message::Noop)
            },
        ))
    }

    fn pick_list() -> Element<'static, Message> {
        wrap(widget::pick_list(
            ["Alpha", "Beta", "Gamma"],
            Some("Beta"),
            |value| {
                Message::ExtensionField(
                    "mode".into(),
                    serde_json::json!(value),
                    Some("changed".into()),
                )
            },
        ))
    }

    fn with_content(mut content: Element<'static, Message>) -> Self {
        let mut tree = Tree::new(&content);
        let renderer = iced::Renderer::new(Font::DEFAULT, Pixels(14.));
        let viewport = Rectangle::with_size(Size::new(360., 480.));
        let node = content.as_widget_mut().layout(
            &mut tree,
            &renderer,
            &layout::Limits::new(Size::ZERO, viewport.size()),
        );
        Self {
            content,
            tree,
            renderer,
            node,
            viewport,
        }
    }

    fn dispatch(&mut self, event: Event, cursor: mouse::Cursor) -> EventResult {
        self.dispatch_with_clipboard(event, cursor, &mut clipboard::Null)
    }

    fn dispatch_with_clipboard(
        &mut self,
        event: Event,
        cursor: mouse::Cursor,
        clipboard: &mut dyn Clipboard,
    ) -> EventResult {
        let mut messages = Vec::new();
        let (status, layout_invalid, redraw_request) = {
            let mut shell = Shell::new(&mut messages);
            if let Some(mut overlay) = self.content.as_widget_mut().overlay(
                &mut self.tree,
                Layout::new(&self.node),
                &self.renderer,
                &self.viewport,
                Vector::ZERO,
            ) {
                let node = overlay
                    .as_overlay_mut()
                    .layout(&self.renderer, self.viewport.size());
                overlay.as_overlay_mut().update(
                    &event,
                    Layout::new(&node),
                    cursor,
                    &self.renderer,
                    clipboard,
                    &mut shell,
                );
            }
            if !shell.is_event_captured() {
                self.content.as_widget_mut().update(
                    &mut self.tree,
                    &event,
                    Layout::new(&self.node),
                    cursor,
                    &self.renderer,
                    clipboard,
                    &mut shell,
                    &self.viewport,
                );
            }
            (
                shell.event_status(),
                shell.is_layout_invalid(),
                shell.redraw_request(),
            )
        };
        if layout_invalid {
            self.node = self.content.as_widget_mut().layout(
                &mut self.tree,
                &self.renderer,
                &layout::Limits::new(Size::ZERO, self.viewport.size()),
            );
        }
        EventResult {
            messages,
            status,
            layout_invalid,
            redraw_request,
        }
    }

    fn menu_bounds(&mut self) -> Option<Rectangle> {
        self.content
            .as_widget_mut()
            .overlay(
                &mut self.tree,
                Layout::new(&self.node),
                &self.renderer,
                &self.viewport,
                Vector::ZERO,
            )
            .map(|mut overlay| {
                overlay
                    .as_overlay_mut()
                    .layout(&self.renderer, self.viewport.size())
                    .bounds()
            })
    }

    fn open(&mut self) {
        assert!(self.menu_bounds().is_none());
        let result = self.dispatch(
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
            mouse::Cursor::Available(self.node.bounds().center()),
        );
        assert_eq!(result.status, event::Status::Captured);
        assert!(result.messages.is_empty());
        assert!(self.menu_bounds().is_some());
    }

    fn escape(&mut self, modifiers: keyboard::Modifiers) -> EventResult {
        self.dispatch(
            Event::Keyboard(keyboard::Event::KeyPressed {
                key: keyboard::Key::Named(keyboard::key::Named::Escape),
                modified_key: keyboard::Key::Named(keyboard::key::Named::Escape),
                physical_key: keyboard::key::Physical::Code(keyboard::key::Code::Escape),
                location: keyboard::Location::Standard,
                modifiers,
                text: None,
                repeat: false,
            }),
            mouse::Cursor::Unavailable,
        )
    }

    fn click_child(&mut self, index: usize) -> EventResult {
        let position = Layout::new(&self.node)
            .children()
            .nth(index)
            .unwrap()
            .bounds()
            .center();
        self.dispatch(
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
            mouse::Cursor::Available(position),
        )
    }

    fn input_is_focused(&self) -> bool {
        self.tree.children[0].children[0]
            .state
            .downcast_ref::<
                widget::text_input::State<<iced::Renderer as text::Renderer>::Paragraph>,
            >()
            .is_focused()
    }
}

#[derive(Default)]
struct TestClipboard {
    reads: Cell<usize>,
    writes: usize,
}

impl Clipboard for TestClipboard {
    fn read(&self, _kind: clipboard::Kind) -> Option<String> {
        self.reads.set(self.reads.get() + 1);
        Some("pasted".into())
    }

    fn write(&mut self, _kind: clipboard::Kind, _contents: String) {
        self.writes += 1;
    }
}

fn keypress(
    key: keyboard::Key,
    code: keyboard::key::Code,
    modifiers: keyboard::Modifiers,
    text: Option<&str>,
) -> Event {
    Event::Keyboard(keyboard::Event::KeyPressed {
        modified_key: key.clone(),
        key,
        physical_key: keyboard::key::Physical::Code(code),
        location: keyboard::Location::Standard,
        modifiers,
        text: text.map(Into::into),
        repeat: false,
    })
}

#[test]
fn escape_dismisses_an_open_dropdown_without_changing_the_value() {
    let mut dropdown = Dropdown::new();
    let initial = dropdown.escape(keyboard::Modifiers::empty());
    assert_eq!(initial.status, event::Status::Ignored);
    assert!(initial.messages.is_empty());
    assert!(!initial.layout_invalid);

    dropdown.open();
    let dismissed = dropdown.escape(keyboard::Modifiers::empty());
    assert_eq!(dismissed.status, event::Status::Captured);
    assert!(matches!(
        dismissed.messages.as_slice(),
        [Message::DropdownDismissed]
    ));
    assert!(dismissed.layout_invalid);
    assert_eq!(dismissed.redraw_request, window::RedrawRequest::NextFrame);
    assert!(dropdown.menu_bounds().is_none());

    let repeated = dropdown.escape(keyboard::Modifiers::empty());
    assert_eq!(repeated.status, event::Status::Ignored);
    assert!(repeated.messages.is_empty());
    assert!(!repeated.layout_invalid);
}

#[test]
fn dismissed_dropdown_reopens_with_its_selection_and_can_select_another_option() {
    let mut dropdown = Dropdown::new();
    dropdown.open();
    assert!(matches!(
        dropdown
            .escape(keyboard::Modifiers::empty())
            .messages
            .as_slice(),
        [Message::DropdownDismissed]
    ));

    dropdown.open();
    let menu = dropdown.menu_bounds().unwrap();
    let selected = dropdown.dispatch(
        Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
        mouse::Cursor::Available(menu.center()),
    );
    assert_eq!(selected.status, event::Status::Captured);
    assert!(matches!(
        selected.messages.as_slice(),
        [Message::ExtensionField(id, value, Some(callback))]
            if id == "mode" && value == "Beta" && callback == "changed"
    ));
    assert!(dropdown.menu_bounds().is_none());

    dropdown.open();
    let menu = dropdown.menu_bounds().unwrap();
    let position = Point::new(menu.center_x(), menu.y + menu.height * 5. / 6.);
    let hovered = dropdown.dispatch(
        Event::Mouse(mouse::Event::CursorMoved { position }),
        mouse::Cursor::Available(position),
    );
    assert!(hovered.messages.is_empty());
    let selected = dropdown.dispatch(
        Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
        mouse::Cursor::Available(position),
    );
    assert_eq!(selected.status, event::Status::Captured);
    assert!(matches!(
        selected.messages.as_slice(),
        [Message::ExtensionField(id, value, Some(callback))]
            if id == "mode" && value == "Gamma" && callback == "changed"
    ));
    assert!(dropdown.menu_bounds().is_none());
}

#[test]
fn escape_preserves_held_modifiers_for_subsequent_selection_shortcuts() {
    let mut dropdown = Dropdown::new();
    dropdown.dispatch(
        Event::Keyboard(keyboard::Event::ModifiersChanged(keyboard::Modifiers::CTRL)),
        mouse::Cursor::Unavailable,
    );
    dropdown.open();
    assert!(matches!(
        dropdown
            .escape(keyboard::Modifiers::CTRL)
            .messages
            .as_slice(),
        [Message::DropdownDismissed]
    ));
    assert!(dropdown.menu_bounds().is_none());

    let selected = dropdown.dispatch(
        Event::Mouse(mouse::Event::WheelScrolled {
            delta: mouse::ScrollDelta::Lines { x: 0., y: -1. },
        }),
        mouse::Cursor::Available(dropdown.node.bounds().center()),
    );
    assert_eq!(selected.status, event::Status::Captured);
    assert!(matches!(
        selected.messages.as_slice(),
        [Message::ExtensionField(id, value, Some(callback))]
            if id == "mode" && value == "Gamma" && callback == "changed"
    ));
}

#[test]
fn escape_scope_navigates_back_when_a_text_input_captures_escape_to_unfocus() {
    let mut scope = Dropdown::scoped();
    assert!(scope.click_child(0).messages.is_empty());
    assert!(scope.input_is_focused());

    let escaped = scope.escape(keyboard::Modifiers::empty());
    assert_eq!(escaped.status, event::Status::Captured);
    assert!(!scope.input_is_focused());
    assert!(matches!(escaped.messages.as_slice(), [Message::Back]));
}

#[test]
fn escape_scope_matches_dismissals_to_their_own_event_with_queued_messages() {
    let mut scope = Dropdown::scoped();
    let mut queued = scope.click_child(0).messages;
    assert!(scope.input_is_focused());

    queued.extend(scope.escape(keyboard::Modifiers::empty()).messages);
    assert!(matches!(queued.as_slice(), [Message::Back]));
    assert!(!scope.input_is_focused());

    queued.extend(scope.click_child(1).messages);
    assert!(scope.menu_bounds().is_some());
    let dismissed = scope.escape(keyboard::Modifiers::empty());
    assert_eq!(dismissed.status, event::Status::Captured);
    assert!(dismissed.layout_invalid);
    assert_eq!(dismissed.redraw_request, window::RedrawRequest::NextFrame);
    assert!(matches!(dismissed.messages.as_slice(), [Message::Noop]));
    assert!(scope.menu_bounds().is_none());
    queued.extend(dismissed.messages);

    queued.extend(scope.escape(keyboard::Modifiers::empty()).messages);
    assert!(matches!(
        queued.as_slice(),
        [Message::Back, Message::Noop, Message::Back]
    ));

    queued.extend(scope.click_child(0).messages);
    assert!(scope.input_is_focused());
    queued.extend(scope.escape(keyboard::Modifiers::empty()).messages);
    assert!(!scope.input_is_focused());
    assert!(matches!(
        queued.as_slice(),
        [Message::Back, Message::Noop, Message::Back, Message::Back]
    ));
}

#[test]
fn claimed_extension_shortcut_prevents_native_paste_but_plain_paste_still_works() {
    let mut scope = Dropdown::keyboard_scope();
    assert!(scope.click_child(0).messages.is_empty());
    assert!(scope.input_is_focused());
    let mut clipboard = TestClipboard::default();
    let shortcut_modifiers = keyboard::Modifiers::CTRL | keyboard::Modifiers::SHIFT;
    scope.dispatch_with_clipboard(
        Event::Keyboard(keyboard::Event::ModifiersChanged(shortcut_modifiers)),
        mouse::Cursor::Unavailable,
        &mut clipboard,
    );

    let claimed = scope.dispatch_with_clipboard(
        keypress(
            keyboard::Key::Character("v".into()),
            keyboard::key::Code::KeyV,
            shortcut_modifiers,
            None,
        ),
        mouse::Cursor::Unavailable,
        &mut clipboard,
    );
    assert_eq!(claimed.status, event::Status::Captured);
    assert!(matches!(claimed.messages.as_slice(), [Message::Noop]));
    assert_eq!(clipboard.reads.get(), 0);
    assert_eq!(clipboard.writes, 0);
    assert!(scope.input_is_focused());

    scope.dispatch_with_clipboard(
        Event::Keyboard(keyboard::Event::ModifiersChanged(keyboard::Modifiers::CTRL)),
        mouse::Cursor::Unavailable,
        &mut clipboard,
    );
    let pasted = scope.dispatch_with_clipboard(
        keypress(
            keyboard::Key::Character("v".into()),
            keyboard::key::Code::KeyV,
            keyboard::Modifiers::CTRL,
            None,
        ),
        mouse::Cursor::Unavailable,
        &mut clipboard,
    );
    assert_eq!(pasted.status, event::Status::Captured);
    assert!(matches!(
        pasted.messages.as_slice(),
        [Message::Query(value), Message::Key(key, modifiers, true)]
            if value == "pasted"
                && key.as_ref() == keyboard::Key::Character("v")
                && *modifiers == keyboard::Modifiers::CTRL
    ));
    assert_eq!(clipboard.reads.get(), 1);
    assert_eq!(clipboard.writes, 0);
}

#[test]
fn captured_enter_emits_only_the_native_submit_message() {
    let mut scope = Dropdown::keyboard_scope();
    scope.click_child(0);
    assert!(scope.input_is_focused());

    let submitted = scope.dispatch(
        keypress(
            keyboard::Key::Named(keyboard::key::Named::Enter),
            keyboard::key::Code::Enter,
            keyboard::Modifiers::empty(),
            None,
        ),
        mouse::Cursor::Unavailable,
    );
    assert_eq!(submitted.status, event::Status::Captured);
    assert!(matches!(submitted.messages.as_slice(), [Message::Submit]));
}

#[test]
fn keyboard_scope_forwards_each_unclaimed_key_after_native_editing() {
    let mut scope = Dropdown::keyboard_scope();
    scope.click_child(0);
    assert!(scope.input_is_focused());

    let edited = scope.dispatch(
        keypress(
            keyboard::Key::Character("a".into()),
            keyboard::key::Code::KeyA,
            keyboard::Modifiers::empty(),
            Some("a"),
        ),
        mouse::Cursor::Unavailable,
    );
    assert_eq!(edited.status, event::Status::Captured);
    assert!(matches!(
        edited.messages.as_slice(),
        [Message::Query(value), Message::Key(key, modifiers, true)]
            if value == "a"
                && key.as_ref() == keyboard::Key::Character("a")
                && modifiers.is_empty()
    ));

    let unhandled = scope.dispatch(
        keypress(
            keyboard::Key::Named(keyboard::key::Named::F2),
            keyboard::key::Code::F2,
            keyboard::Modifiers::empty(),
            None,
        ),
        mouse::Cursor::Unavailable,
    );
    assert!(matches!(
        unhandled.messages.as_slice(),
        [Message::Key(key, modifiers, false)]
            if *key == keyboard::Key::Named(keyboard::key::Named::F2)
                && modifiers.is_empty()
    ));
}
