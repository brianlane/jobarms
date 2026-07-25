import { describe, expect, it } from "vitest";
import { htmlToText, looksLikeStrippedTemplate } from "../src/html-text";

describe("htmlToText", () => {
  it("drops the CONTENTS of style, script, title, head, and comments", () => {
    const html = [
      "<head><title>*|MC:SUBJECT|*</title></head>",
      "<style>.a{color:red;}</style>",
      "<script>var x = 1;</script>",
      "<!-- [if mso]> junk <![endif] -->",
      "<p>Real body</p>"
    ].join("");
    expect(htmlToText(html)).toBe("Real body");
  });

  it("keeps anchor URLs so a verify button survives flattening", () => {
    const html = '<a href="https://acme.wd1.myworkdayjobs.com/verify?token=t9">Verify Email</a>';
    expect(htmlToText(html)).toBe("Verify Email (https://acme.wd1.myworkdayjobs.com/verify?token=t9)");
  });

  it("leaves non-http anchors as plain label text", () => {
    expect(htmlToText('<a href="#top">Top</a>')).toBe("Top");
  });

  it("decodes entities, with &amp; resolved last", () => {
    expect(htmlToText("<p>a&nbsp;&amp;lt;b&gt;&quot;c&quot;&#39;</p>")).toBe('a &lt;b>"c"\'');
  });

  it("collapses whitespace and trims", () => {
    expect(htmlToText("<p>  a\n\n   b  </p>")).toBe("a b");
  });

  it("returns empty for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("looksLikeStrippedTemplate", () => {
  it("detects a merge tag", () => {
    expect(looksLikeStrippedTemplate("hello *|FNAME|* welcome")).toBe(true);
  });

  it("ignores an empty merge-tag shape", () => {
    expect(looksLikeStrippedTemplate("*||* plain prose")).toBe(false);
  });

  it("detects three or more CSS rule blocks", () => {
    expect(looksLikeStrippedTemplate("a{color:red;} b{width:1px;} c{margin:0;}")).toBe(true);
  });

  it("treats two rule blocks as prose", () => {
    expect(looksLikeStrippedTemplate("a{color:red;} b{width:1px;}")).toBe(false);
  });

  it("treats ordinary prose as prose", () => {
    expect(looksLikeStrippedTemplate("Thanks for applying. Your code is 123456.")).toBe(false);
  });
});
