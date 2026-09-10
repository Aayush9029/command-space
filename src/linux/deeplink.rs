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
    if let Some(target) = parameters.get("target") {
        return Ok(Destination::Search(target.to_string()));
    }
    if let Some(query) = parameters.get("query") {
        return Ok(Destination::Search(query.to_string()));
    }
    let host = url.host_str().unwrap_or_default();
    let segments = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if matches!(host, "extension" | "extensions") {
        let offset = if url.scheme() == "raycast" { 1 } else { 0 };
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
        return Ok(Destination::Extension {
            extension,
            command,
            arguments,
        });
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
        assert_eq!(parse("raycast://extensions/author/base64/decode?arguments=%7B%22text%22%3A%22aGVsbG8%3D%22%7D").unwrap(), Destination::Extension { extension:"base64".into(), command:"decode".into(), arguments:serde_json::json!({"text":"aGVsbG8="}) });
        assert!(parse("command-space://extension/a/../../shell").is_err());
        assert!(parse("command-space://extension/a/b?arguments=[]").is_err());
    }
}
