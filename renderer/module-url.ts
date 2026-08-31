const MODULE_QUERY_KEYS = ["state", "view", "qa"] as const;

/**
 * Resolve a compiled module for either the public viewer or the private
 * loopback renderer, and forward the complete render target into its iframe.
 */
export function buildAtlasModuleUrl(
  viewerUrl: string,
  pageUrl: string,
  artifactBase: string | null,
  query: URLSearchParams,
): URL {
  const moduleUrl = privateArtifactUrl(viewerUrl, pageUrl, artifactBase);
  for (const key of MODULE_QUERY_KEYS) {
    const value = query.get(key);
    if (value !== null) moduleUrl.searchParams.set(key, value);
  }
  return moduleUrl;
}

/** Keep immutable public artifact URLs public except inside loopback QA. */
export function privateArtifactUrl(value: string, pageUrl: string, artifactBase: string | null): URL {
  const artifact = new URL(value, pageUrl);
  if (!artifactBase || !artifact.pathname.startsWith("/artifacts/")) return artifact;
  try {
    const base = new URL(artifactBase, pageUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return artifact;
    return new URL(`${artifact.pathname}${artifact.search}${artifact.hash}`, base);
  } catch {
    return artifact;
  }
}
