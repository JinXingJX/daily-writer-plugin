import { describe, expect, it } from "vitest";
import { extractChapter } from "./webChapter";

describe("web chapter import", () => {
  it("keeps the title and the block of paragraphs with the most text", () => {
    const body = Array.from({ length: 6 }, (_, index) => `<p>　　第${index + 1}段，雨还在下&nbsp;&ldquo;走吧&rdquo;。</p>`).join("\n");
    const html = `<html><head><title>第三章 雨夜_某书_小说网</title><script>var x = "<p>脚本</p>";</script></head><body>
      <nav><div><p>首页</p><p>书架</p></div></nav>
      <h1 class="title">第三章 雨夜</h1>
      <main><div class="content">${body}</div></main>
      <footer><div><p>本站推荐</p></div></footer></body></html>`;
    const chapter = extractChapter(html);
    expect(chapter.title).toBe("第三章 雨夜");
    expect(chapter.text.split("\n")).toHaveLength(6);
    expect(chapter.text).toContain("第1段，雨还在下 “走吧”。");
    expect(chapter.text).not.toContain("首页");
    expect(chapter.text).not.toContain("脚本");
  });

  it("falls back to the page title and the body text when there are no paragraphs", () => {
    const chapter = extractChapter("<html><head><title>番外 | 站点</title></head><body><div>一行<br>两行</div></body></html>");
    expect(chapter).toEqual({ title: "番外", text: "一行\n两行" });
  });
});
