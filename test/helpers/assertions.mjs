export function includesIgnoreCase(text, fragment) {
  return String(text).toLowerCase().includes(String(fragment).toLowerCase());
}
