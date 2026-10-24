/** A CVM that is down, unreachable or blocks browser requests surfaces as a bare "Failed to fetch"; say which CVM. */
export function cvmError(e: unknown, url: string): string {
  const m = e instanceof Error ? e.message.split('\n')[0] : String(e);
  if (!/failed to fetch|fetch failed|networkerror|load failed/i.test(m)) return m;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the text the user typed
  }
  return `The agent's CVM at ${host} did not answer. Check that it is running and allows requests from this page.`;
}
