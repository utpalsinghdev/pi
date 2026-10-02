export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function parseLabel(raw: string): string {
  return normalize(raw);
}
