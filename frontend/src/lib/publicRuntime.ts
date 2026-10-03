/** Public builds get a per-data-directory identity before any store hydrates. */
const meta = (name: string) => typeof document === "undefined" ? "" : document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || "";
export const runtimeToken = meta("sbm-instance");
const identity = meta("sbm-profile");
export const storageKey = (legacy: string) => identity ? `sbm-${identity}-${legacy}` : legacy;

// Old tabs cannot submit cached data to a new public instance at the same port.
if (runtimeToken) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin) return nativeFetch(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("X-SBM-Instance", runtimeToken);
    return nativeFetch(input, { ...init, headers });
  };
}
