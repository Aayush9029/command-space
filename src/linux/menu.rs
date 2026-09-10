use super::model::{Action, Entry, home, shell_quote};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    process::Command,
};

mod native;
pub mod packages;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MenuItem {
    pub id: String,
    pub parent: String,
    pub label: String,
    pub title: String,
    pub description: String,
    pub icon: String,
    #[serde(rename = "iconFont")]
    pub icon_font: String,
    pub action: String,
    pub target: String,
    pub provider: String,
    pub aliases: Vec<String>,
    pub when: String,
    pub checked: String,
}

#[derive(Clone, Debug, Default)]
pub struct Menu {
    pub items: Vec<MenuItem>,
    pub conditions: HashMap<String, bool>,
    pub checks: HashMap<String, bool>,
}

impl Menu {
    pub fn load() -> Result<Self, String> {
        let root = std::env::var("OMARCHY_PATH").unwrap_or_else(|_| "/usr/share/omarchy".into());
        let mut menu = Self::default();
        menu.merge_file(
            Path::new(&root)
                .join("default/omarchy/omarchy-menu.jsonc")
                .as_path(),
        )?;
        let custom = home().join(".config/omarchy/extensions/omarchy-menu.jsonc");
        if custom.exists() {
            menu.merge_file(&custom)?;
        }
        Ok(menu)
    }

    fn merge_file(&mut self, path: &Path) -> Result<(), String> {
        self.merge(&fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?)
    }

    pub fn merge(&mut self, raw: &str) -> Result<(), String> {
        if raw.trim().is_empty() {
            return Ok(());
        }
        let document: Value = json5::from_str(raw).map_err(|e| e.to_string())?;
        let source = document
            .get("items")
            .unwrap_or(&document)
            .as_object()
            .ok_or("Menu must be an object")?;
        for (id, item) in source {
            if !item.is_object() {
                continue;
            }
            let mut value = item.clone();
            if let Some(alias) = value.get("aliases").and_then(Value::as_str) {
                value["aliases"] = serde_json::json!([alias]);
            }
            let mut item: MenuItem =
                serde_json::from_value(value).map_err(|e| format!("Menu entry {id}: {e}"))?;
            item.id = id.clone();
            if item.label.is_empty() {
                item.label = id.clone();
            }
            if !source[id].as_object().unwrap().contains_key("parent") {
                item.parent = id.rsplit_once('.').map_or("root", |(p, _)| p).into();
            }
            if let Some(existing) = self.items.iter_mut().find(|e| e.id == *id) {
                *existing = item;
            } else {
                self.items.push(item);
            }
        }
        Ok(())
    }

    pub fn evaluate_conditions(&mut self) {
        let mut script = String::new();
        let mut pending = 0;
        for (index, item) in self.items.iter().enumerate() {
            for (kind, condition) in [("when", &item.when), ("checked", &item.checked)] {
                if !condition.is_empty() {
                    script.push_str(&format!("{{ if ( {condition} ) >/dev/null 2>&1; then printf '{index} {kind} 1\\n'; else printf '{index} {kind} 0\\n'; fi; }} &\n"));
                    pending += 1;
                    if pending == 8 {
                        script.push_str("wait\n");
                        pending = 0;
                    }
                }
            }
        }
        script.push_str("wait\n");
        let Ok(output) = Command::new("timeout")
            .args(["20", "bash", "-lc", &script])
            .output()
        else {
            return;
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() != 3 {
                continue;
            }
            let Some(item) = fields[0]
                .parse::<usize>()
                .ok()
                .and_then(|i| self.items.get(i))
            else {
                continue;
            };
            let map = if fields[1] == "when" {
                &mut self.conditions
            } else {
                &mut self.checks
            };
            map.insert(item.id.clone(), fields[2] == "1");
        }
    }

    pub fn resolve(&self, route: &str) -> String {
        if route.starts_with("native-confirm:") {
            return route.into();
        }
        let route = route.to_lowercase().replace('_', "-");
        if matches!(route.as_str(), "" | "go" | "menu") {
            return "root".into();
        }
        self.items
            .iter()
            .find(|item| item.id == route)
            .or_else(|| {
                self.items.iter().find(|item| {
                    item.aliases
                        .iter()
                        .any(|a| a.to_lowercase().replace('_', "-") == route)
                })
            })
            .map_or(route, |item| {
                if matches!(native::action(item), Some(Action::Builtin(ref name)) if name == "emoji") {
                    "emoji".into()
                } else if item.target.is_empty() {
                    item.id.clone()
                } else {
                    item.target.clone()
                }
            })
    }

    pub fn title(&self, route: &str) -> String {
        if let Some(title) = native::title(route) {
            return title;
        }
        if route == "root" {
            return "Command Space".into();
        }
        self.items.iter().find(|i| i.id == route).map_or_else(
            || route.into(),
            |i| {
                if i.title.is_empty() {
                    i.label.clone()
                } else {
                    i.title.clone()
                }
            },
        )
    }

    pub fn native_action(&self, route: &str) -> Option<Action> {
        self.items
            .iter()
            .find(|item| item.id == route)
            .and_then(native::action)
    }

    pub fn package_operation(&self, route: &str) -> Option<packages::Operation> {
        self.items
            .iter()
            .find(|item| item.id == route)
            .and_then(|item| native::package_operation(&item.action))
    }

    pub fn breadcrumb(&self, item: &MenuItem) -> String {
        let mut labels = vec![];
        let mut parent = item.parent.as_str();
        let mut seen = HashSet::new();
        while parent != "root" && !parent.is_empty() && seen.insert(parent) {
            if let Some(entry) = self.items.iter().find(|e| e.id == parent) {
                labels.push(entry.label.as_str());
                parent = &entry.parent;
            } else {
                break;
            }
        }
        labels.reverse();
        labels.join(" › ")
    }

    pub fn visible(&self, id: &str, seen: &mut HashSet<String>) -> bool {
        if !seen.insert(id.into()) {
            return false;
        }
        let Some(item) = self.items.iter().find(|e| e.id == id) else {
            return false;
        };
        if self.conditions.get(id) == Some(&false) {
            return false;
        }
        if !item.action.is_empty() || !item.provider.is_empty() {
            return true;
        }
        let target = if item.target.is_empty() {
            id
        } else {
            &item.target
        };
        self.items
            .iter()
            .filter(|e| e.parent == target)
            .any(|e| self.visible(&e.id, &mut seen.clone()))
    }

    pub fn entries(&self, route: &str, search_all: bool) -> Vec<Entry> {
        self.items
            .iter()
            .filter(|item| {
                item.id != "root"
                    && (if search_all {
                        self.descendant_of(&item.id, route)
                    } else {
                        item.parent == route
                    })
                    && self.visible(&item.id, &mut HashSet::new())
            })
            .map(|item| {
                let action = if let Some(action) = native::action(item) {
                    match action {
                        Action::Menu(route) => Action::Menu(self.resolve(&route)),
                        action => action,
                    }
                } else if !item.action.is_empty() {
                    Action::Shell(item.action.clone())
                } else {
                    Action::Menu(if item.target.is_empty() {
                        item.id.clone()
                    } else {
                        item.target.clone()
                    })
                };
                let title = if self.checks.get(&item.id) == Some(&true) {
                    format!("{} ✓", item.label)
                } else {
                    item.label.clone()
                };
                let subtitle = if item.description.is_empty() {
                    self.breadcrumb(item)
                } else {
                    item.description.clone()
                };
                let mut entry = Entry::new(&item.id, &title, &subtitle, &item.icon, action);
                entry.keywords = format!("{} {}", item.id, item.aliases.join(" "));
                entry.icon_font = item.icon_font.clone();
                entry
            })
            .collect()
    }

    pub fn descendant_of(&self, id: &str, ancestor: &str) -> bool {
        if ancestor == "root" {
            return id != "root";
        }
        let mut id = id;
        let mut seen = HashSet::new();
        while seen.insert(id) {
            let Some(item) = self.items.iter().find(|item| item.id == id) else {
                break;
            };
            if item.parent == ancestor {
                return true;
            }
            id = &item.parent;
        }
        false
    }

    pub fn provider(&self, route: &str) -> Vec<Entry> {
        if let Some(entries) = native::provider(self, route) {
            return entries;
        }
        let Some(item) = self.items.iter().find(|e| e.id == route) else {
            return vec![];
        };
        if item.provider == "apps" {
            return super::desktop::apps();
        }
        let (list, current, action) = match item.provider.as_str() {
            "fonts" => (
                "omarchy-font-list",
                "omarchy-font-current",
                "omarchy-font-set",
            ),
            "power-profiles" => (
                "omarchy-powerprofiles-list",
                "powerprofilesctl get",
                "omarchy-powerprofiles-set autodetect",
            ),
            _ => return vec![],
        };
        let selected = Command::new("bash")
            .args(["-lc", current])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let output = Command::new("bash").args(["-lc", list]).output();
        output
            .ok()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .enumerate()
                    .filter(|(_, v)| !v.trim().is_empty())
                    .map(|(index, value)| {
                        let title = if value == selected {
                            format!("{value} ✓")
                        } else {
                            value.into()
                        };
                        Entry::new(
                            &format!("{route}.provider.{index}"),
                            &title,
                            &item.label,
                            &item.icon,
                            Action::Shell(format!("{action} {}", shell_quote(value))),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_routes_and_aliases_keep_actions() {
        let mut menu = Menu::default();
        menu.merge(
            r#"{
            "install": {"label":"Install"},
            "install.dev": {"label":"Development", "aliases":"dev"},
            "install.dev.rust": {"label":"Rust", "action":"install-rust"},
        }"#,
        )
        .unwrap();
        assert_eq!(menu.resolve("dev"), "install.dev");
        assert_eq!(
            menu.entries("install", false)[0].action,
            Action::Menu("install.dev".into())
        );
        let leaf = &menu.entries("install.dev", false)[0];
        assert_eq!(leaf.action, Action::Shell("install-rust".into()));
        assert_eq!(leaf.subtitle, "Install › Development");
        menu.merge(r#"{"install.dev.rust":{"label":"Custom Rust","action":"custom-rust"}}"#)
            .unwrap();
        assert_eq!(menu.items.len(), 3);
        assert_eq!(
            menu.entries("install.dev", false)[0].action,
            Action::Shell("custom-rust".into())
        );
    }

    #[test]
    fn scoped_search_and_exact_routes_match_omarchy() {
        let mut menu = Menu::default();
        menu.merge(r#"{"first":{"aliases":["second"]},"first.leaf":{"action":"one"},"second":{"aliases":["alias-name"]},"second.leaf":{"action":"two"}}"#).unwrap();
        assert_eq!(menu.resolve("second"), "second");
        assert_eq!(menu.resolve("ALIAS_NAME"), "second");
        assert_eq!(menu.resolve("go"), "root");
        assert_eq!(
            menu.entries("first", true)
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first.leaf"]
        );
    }

    #[test]
    fn empty_menus_and_condition_failures_are_hidden_without_recursing_forever() {
        let mut menu = Menu::default();
        menu.merge(r#"{"empty":{},"hidden":{"action":"true","when":"false"},"loop":{"target":"loop"},"parent":{},"parent.leaf":{"action":"true"}}"#).unwrap();
        menu.conditions.insert("hidden".into(), false);
        assert_eq!(
            menu.entries("root", false)
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["parent"]
        );
    }
}
