import { FieldError } from "./workflows.mjs";

function integer(value, field, label, minimum) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(number) || number < minimum || number > 2147483647) {
    throw new FieldError(field, minimum === 1 ? `${label} must be a positive whole number` : `${label} must be a whole number`);
  }
  return number;
}

export function moveBounds(values) {
  return { position: {
    x: integer(values.x, "x", "X", -2147483648),
    y: integer(values.y, "y", "Y", -2147483648),
  } };
}

export function resizeBounds(values) {
  return { size: {
    width: integer(values.width, "width", "Width", 1),
    height: integer(values.height, "height", "Height", 1),
  } };
}
