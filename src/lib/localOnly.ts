// Local servers are for this machine only. These checks keep web pages out of them:
// the Host must be a loopback name, browser origins must be on this machine,
// and some endpoints only take requests from local processes.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function bareHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  return h.replace(/:\d+$/, "");
}

export function isLocalHost(hostHeader: string | undefined): boolean {
  return !!hostHeader && LOOPBACK.has(bareHost(hostHeader));
}

/** No Origin (a local non-browser client) or an http origin on a loopback host. */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && LOOPBACK.has(bareHost(u.host));
  } catch {
    return false;
  }
}

/** True for requests made by a local process rather than a web page. */
export function fromLocalProcess(origin: string | undefined, secFetchSite: string | undefined): boolean {
  if (origin) return false;
  return !secFetchSite || secFetchSite === "none";
}
