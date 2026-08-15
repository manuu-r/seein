export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "scene";
}

export function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function safeFilename(value: string): string {
  return slugify(value).slice(0, 64);
}

