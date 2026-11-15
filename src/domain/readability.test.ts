import { describe, expect, it } from "vitest";
import { hardSpots, readabilityHints, readabilityStats } from "./readability";

const LONG = "那个三天前在城西当铺里用半块碎银换走了他父亲临终前留给他唯一一件旧物的瘦高男人此刻正站在门口";
const CHAIN = "他想起掌柜的侄子的那间铺子的账本";
const ABSTRACT = "沉默吞没了整间屋子。";
const DIALOGUE = ["“你来了。”", "“来了。”", "“货呢？”", "“在船上。”", "“哪条船？”", "“老周的船。”"].join("\n");
const PLAIN = "老周把当票拍在桌上。掌柜看了一眼，脸就白了。\n“这票是假的。”他说。\n老周笑了：“那你报官去。”";

describe("readability proxies", () => {
  it("flags each kind once and leaves plain prose alone", () => {
    const text = [LONG + "。", CHAIN + "。", ABSTRACT, DIALOGUE].join("\n");
    expect(readabilityStats(text)).toMatchObject({ longClauses: 1, modifierChains: 1, abstractSubjects: 1, dialogueRuns: 1 });
    const hints = readabilityHints(text);
    expect(new Set(hints.map((hint) => hint.kind))).toEqual(new Set(["clause", "modifiers", "dialogue"]));
    for (const hint of hints) expect(text.includes(hint.quote), hint.quote).toBe(true);
    expect(hints.some((hint) => hint.kind === "abstract")).toBe(false);
    expect(hardSpots(readabilityStats(PLAIN))).toBe(0);
    expect(readabilityHints(PLAIN)).toEqual([]);
  });

  it("does not count 目的 or 的确 as modifiers", () => {
    expect(readabilityStats("他的目的的确是她的钱。").modifierChains).toBe(0);
  });

  it("skips a kind the style samples use as often: that is the author's voice", () => {
    const draft = `${PLAIN}\n${ABSTRACT}\n${LONG}。`;
    const samples = `${"沉默吞没了屋子。寒意爬上了脊背。老周笑了一声，没说话，转身走了。".repeat(12)}${PLAIN.repeat(6)}`;
    const kinds = readabilityHints(draft, samples).map((hint) => hint.kind);
    expect(kinds).not.toContain("abstract");
    expect(kinds).toContain("clause");
    expect(readabilityHints(draft, "太短").map((hint) => hint.kind)).not.toContain("abstract");
  });

  it("spreads the limit across kinds", () => {
    const text = `${Array.from({ length: 6 }, (_, index) => `${LONG}${index}。`).join("\n")}\n${ABSTRACT}`;
    const hints = readabilityHints(text, "", 3);
    expect(hints).toHaveLength(3);
    expect(hints.map((hint) => hint.kind)).not.toContain("abstract");
  });
});
