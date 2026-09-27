import { esc } from "./html.ts";

/** Recheck stored/imported URLs before making them active browser content. */
export function mediaImage(value: unknown, title: unknown, cover = false): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return `<img class="${cover ? "cover-image" : "project-image"}" src="${esc(url.href)}" alt="${esc(title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  } catch { return ""; }
}

export function textLines(value: unknown): string {
  return String(value ?? "").split(/\r?\n/).filter((s) => s.trim()).map((line) => `<li>${esc(line)}</li>`).join("");
}
