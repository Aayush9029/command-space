export function chromiumFlags(source, extension, enabled) {
  const lines = source.split("\n");
  const unquote = value => /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  const index = lines.findIndex(line => unquote(line.trim()).startsWith("--load-extension="));
  const current = index < 0 ? [] : unquote(unquote(lines[index].trim()).slice("--load-extension=".length)).split(",").filter(Boolean);
  const extensions = current.filter(value => value !== extension);
  if (enabled) extensions.push(extension);
  const argument = extensions.length ? `--load-extension=${extensions.join(",")}` : "";
  const line = /[\s"']/.test(argument) ? `'${argument.replaceAll("'", "'\\''")}'` : argument;
  if (index >= 0) {
    if (line) lines[index] = line; else lines.splice(index, 1);
  } else if (line) {
    if (lines.at(-1) === "") lines.pop();
    lines.push(line, "");
  }
  return lines.join("\n");
}
