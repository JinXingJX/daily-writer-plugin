/** Strips wrappers models sometimes add around prose. */
export function cleanProse(text: string) {
  return text.replace(/^```[a-z]*\n?|```$/g, "").replace(/^(好的|以下是|下面是)[^\n]*\n+/, "").trim();
}
