import { FieldError, type WorkflowValues } from "./workflows.ts";

function integer(value: unknown, field: string, label: string, minimum: number) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(number) || number < minimum || number > 2147483647) {
    throw new FieldError(field, minimum === 1 ? `${label} must be a positive whole number` : `${label} must be a whole number`);
  }
  return number;
}

export function moveBounds(values: WorkflowValues) {
  return { position: {
    x: integer(values.x, "x", "X", -2147483648),
    y: integer(values.y, "y", "Y", -2147483648),
  } };
}

export function resizeBounds(values: WorkflowValues) {
  return { size: {
    width: integer(values.width, "width", "Width", 1),
    height: integer(values.height, "height", "Height", 1),
  } };
}
