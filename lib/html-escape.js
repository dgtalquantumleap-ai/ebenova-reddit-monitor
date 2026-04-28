// Escape the five HTML-significant characters for safe interpolation into
// HTML body text and attribute values. Always escape values that originate
// from user input — including fields you "trust" like monitor names.
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c])
