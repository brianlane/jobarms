/**
 * Collapse an HTML email body to readable plain text.
 *
 * The fallback when a message has no usable text/plain part. Stripping tags
 * alone is not enough for templated mail: the CONTENTS of <style>/<script>/
 * <title> and MSO conditional comments sit between tags, so a naive pass leaks
 * whole stylesheets and unrendered merge tags into the "text" that verification
 * extraction then has to read.
 *
 * Dependency-free on purpose so the worker's unit tests can import it directly.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<head\b[^>]*>[\s\S]*?<\/head\b[^>]*>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<title\b[^>]*>[\s\S]*?<\/title\b[^>]*>/gi, " ")
      // Keep link destinations: `<a href="U">label</a>` becomes `label (U)`.
      // Critical here: a Workday "Verify Email" button is an anchor, and
      // tag-stripping alone would discard the very URL we need.
      .replace(
        /<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\b[^>]*>/gi,
        (_m, href: string, label: string) => ` ${label} (${href}) `
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // Decode &amp; LAST so "&amp;lt;" cannot double-unescape into "<".
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * True when a message's "plain text" part is really tag-stripped template
 * source rather than prose. Some senders build the text alternative by naively
 * flattening their HTML, which leaves the stylesheet and merge tags
 * (`*|MC:SUBJECT|*`) behind. A false positive only means the text is re-derived
 * from the HTML part, which is safe.
 */
export function looksLikeStrippedTemplate(text: string): boolean {
  if (/\*\|[^|*\s][^|*]*\|\*/.test(text)) return true;
  const cssBlocks = text.match(/\{[^{}]*:[^{}]*;[^{}]*\}/g);
  return (cssBlocks?.length ?? 0) >= 3;
}
