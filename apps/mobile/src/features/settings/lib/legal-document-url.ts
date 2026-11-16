const REPOSITORY_DOCUMENT_URL = "https://github.com/zjywill/PinaCode/blob/main/";

export const LEGAL_URL = new URL("PRIVACY.md", REPOSITORY_DOCUMENT_URL).toString();

const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  new URL("LICENSE", REPOSITORY_DOCUMENT_URL).toString(),
] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
