/**
 * Only same-origin relative paths are accepted as post-login destinations,
 * so a crafted `?next=` cannot send a freshly signed-in analyst elsewhere.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/alerts";
  }
  if (value.startsWith("/login")) return "/alerts";
  return value;
}
