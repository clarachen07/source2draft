export function parseJsonPayload(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return undefined;
}


export function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 300);
}
