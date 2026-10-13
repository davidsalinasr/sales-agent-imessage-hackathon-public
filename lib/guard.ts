// Security checks kept free of SDK imports so they're easy to test.

/** Comma-separated handles (Apple ID email and/or E.164 phone). Empty means nobody, never everybody. */
export function isOwner(handle: string | undefined, ownerHandles = process.env.OWNER_HANDLE ?? "") {
  const owners = ownerHandles
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!owners.length) {
    console.error("[linq] OWNER_HANDLE is not set; ignoring every sender");
    return false;
  }
  return !!handle && owners.includes(handle.toLowerCase());
}

// A plain approval needs one of these...
const STRONG = new Set(
  (
    "yes yep yeah yup ok okay okey oki sure go approve approved perfect " +
    "dale sí si va vale hazlo mándalo mandalo créalo crealo listo perfecto ándale andale una"
  ).split(" "),
);
// ...and may also contain these ("yes please", "go ahead", "sí por favor", "de una").
const SOFT = new Set("please pls do it ahead for now porfa por favor de una send create".split(" "));
const APPROVAL_EMOJI = /👍|❤|✅|🙌|💯|👌/u;
// Approval emoji, skin tones, variation selectors and light punctuation; anything else means "not just a yes".
const ALLOWED_NON_WORDS = /[\s!.,¡]|👍|❤|✅|🙌|💯|👌|🔥|[\u{1F3FB}-\u{1F3FF}]|\uFE0F/gu;

/**
 * True when the owner's message is nothing but an approval ("yes", "dale 👍", "sí por favor").
 * Questions, changes ("yes but cc Ana") and other emoji (👎) are not approvals, so the agent
 * has to re-propose or ask instead of running the old version.
 */
export function isApproval(text: string) {
  if (text.includes("?")) return false;
  const rest = text.replace(ALLOWED_NON_WORDS, " ");
  if (/[^\p{L}\s]/u.test(rest)) return false;
  const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return APPROVAL_EMOJI.test(text);
  return words.length <= 5 && words.every((w) => STRONG.has(w) || SOFT.has(w)) && words.some((w) => STRONG.has(w));
}

/**
 * Marks third-party content (emails, docs, transcripts, memories) as data for the model.
 * Any closing tag inside the content is neutralised so it can't break out of the wrapper.
 */
export function untrusted(source: string, content: string, maxChars = 20_000) {
  const body = content.length > maxChars ? `${content.slice(0, maxChars)}\n…(truncated)` : content;
  return `<untrusted_data source="${source}">\n${body.replace(/<\/?untrusted_data/gi, "‹untrusted_data")}\n</untrusted_data>`;
}

// Links the agent may show as their own bubble (which renders a preview that fetches the URL).
const PREVIEW_HOSTS = ["docs.google.com", "drive.google.com", "mail.google.com", "calendly.com"];

export function isPreviewableUrl(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && PREVIEW_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Neutralises images: Docs fetches them when the document is created, which could leak data in
 * the URL. Inline images are dropped; anything image-like that's left (nested brackets,
 * reference-style, HTML) is turned into plain text or a plain link.
 */
export function stripMarkdownImages(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/!\[/g, "[");
}
