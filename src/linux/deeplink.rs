use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum Destination {
    OAuth(String),
    Route(String),
    Search(String),
    Extension {
        extension: String,
        command: String,
        arguments: Value,
        launch_context: Value,
        background: bool,
        fallback_text: Option<String>,
    },
}

pub fn parse(value: &str) -> Result<Destination, String> {
    let url = url::Url::parse(value).map_err(|e| e.to_string())?;
    if !matches!(
        url.scheme(),
        "command-space" | "rustcast" | "raycast" | "com.raycast"
    ) {
        return Err("Unsupported launcher URL scheme".into());
    }
    if url.host_str() == Some("oauth") || (url.scheme() == "com.raycast" && url.path() == "/oauth")
    {
        return Ok(Destination::OAuth(value.into()));
    }
    let parameters = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let host = url.host_str().unwrap_or_default();
    let segments = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if matches!(host, "extension" | "extensions") {
        let offset = usize::from(matches!(url.scheme(), "raycast" | "com.raycast"));
        if segments.len() != offset + 2 {
            return Err("Extension link must name one extension and one command".into());
        }
        let extension = segments
            .get(offset)
            .ok_or("Extension name missing from link")?
            .to_string();
        let command = segments
            .get(offset + 1)
            .ok_or("Command name missing from link")?
            .to_string();
        if ![&extension, &command].iter().all(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }) {
            return Err("Invalid extension or command name".into());
        }
        let arguments = parameters
            .get("arguments")
            .map(|raw| serde_json::from_str(raw))
            .transpose()
            .map_err(|e| format!("Invalid command arguments: {e}"))?
            .unwrap_or(Value::Null);
        if !arguments.is_null() && !arguments.is_object() {
            return Err("Command arguments must be a JSON object".into());
        }
        let launch_context = parameters
            .get("context")
            .map(|raw| serde_json::from_str(raw))
            .transpose()
            .map_err(|e| format!("Invalid command launch context: {e}"))?
            .unwrap_or(Value::Null);
        if !launch_context.is_null() && !launch_context.is_object() {
            return Err("Command launch context must be a JSON object".into());
        }
        let background = match parameters.get("launchType").map(|value| value.as_ref()) {
            None | Some("userInitiated") => false,
            Some("background") => true,
            Some(_) => return Err("Invalid command launch type".into()),
        };
        return Ok(Destination::Extension {
            extension,
            command,
            arguments,
            launch_context,
            background,
            fallback_text: parameters
                .get("fallbackText")
                .map(|value| value.to_string()),
        });
    }
    if let Some(target) = parameters.get("target") {
        return Ok(Destination::Search(target.to_string()));
    }
    if let Some(query) = parameters.get("query") {
        return Ok(Destination::Search(query.to_string()));
    }
    let route = if host == "menu" {
        segments.join(".")
    } else {
        host.to_string()
    };
    Ok(Destination::Route(if route.is_empty() {
        "root".into()
    } else if super::catalog::is_builtin_route(&route) {
        format!("builtin:{route}")
    } else {
        route
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_and_encoded_extension_arguments() {
        assert_eq!(
            parse("command-space://clipboard").unwrap(),
            Destination::Route("builtin:clipboard".into())
        );
        assert_eq!(
            parse("rustcast://open?target=12%20cm%20to%20in").unwrap(),
            Destination::Search("12 cm to in".into())
        );
        assert_eq!(parse("raycast://extensions/author/base64/decode?arguments=%7B%22text%22%3A%22aGVsbG8%3D%22%7D").unwrap(), Destination::Extension { extension:"base64".into(), command:"decode".into(), arguments:serde_json::json!({"text":"aGVsbG8="}), launch_context:Value::Null, background:false, fallback_text:None });
        assert!(parse("command-space://extension/a/../../shell").is_err());
        assert!(parse("command-space://extension/a/b?arguments=[]").is_err());
    }

    #[test]
    fn programmatic_links_preserve_background_context_and_fallback_text() {
        for scheme in ["raycast", "com.raycast"] {
            assert_eq!(parse(&format!("{scheme}://extensions/author/fixture/receive?launchType=background&arguments=%7B%22topic%22%3A%22Omarchy%22%7D&context=%7B%22message%22%3A%22Linux%20%E2%9C%93%22%7D&fallbackText=search%20%2B%20text&query=ignored")).unwrap(), Destination::Extension {
                extension:"fixture".into(), command:"receive".into(), arguments:serde_json::json!({"topic":"Omarchy"}), launch_context:serde_json::json!({"message":"Linux ✓"}), background:true, fallback_text:Some("search + text".into()),
            });
        }
        for parameters in [
            "launchType=invalid",
            "context=[]",
            "context=oops",
            "arguments=5",
        ] {
            assert!(
                parse(&format!(
                    "command-space://extension/fixture/receive?{parameters}"
                ))
                .is_err()
            );
        }
        assert!(parse("raycast://extensions/author/fixture/receive/extra").is_err());
    }
}
