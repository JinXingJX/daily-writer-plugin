import { useCallback } from "react";
import { formatTokens } from "../memory/cost";
import { estimatePublishCost } from "../pipeline/cost";
import { useDialogs } from "./common";
import { useWriter } from "./useWriter";

/** Publishing a chapter: states the cost, then starts the background run. */
export function usePublish(chapterId: string | null) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project } = writer;
  const publishing = writer.runs.some((run) => run.template === "publish" && run.chapterId === chapterId && (run.state === "queued" || run.state === "running"));
  const publish = useCallback(async () => {
    if (!project || !chapterId) return;
    const cost = estimatePublishCost(project, chapterId);
    const steps = project.settings.pipeline.steps;
    const parts = [steps.includes("story") ? "、设定与线索" : "", steps.includes("reader") ? "、模拟读者" : "", steps.includes("briefing") ? "、作家简报" : "", steps.includes("notes") ? "、页边朱批" : ""].join("");
    const message = `发布后会在后台：更新本章记忆${parts}${steps.includes("next") ? `，并起草下一章（约 ${project.settings.pipeline.nextWords} 字）` : ""}。\n预计 ${cost.calls} 次模型调用，约 ${formatTokens(cost.inputTokens)} 输入 / ${formatTokens(cost.outputTokens)} 输出 tokens。可以在“编辑部”里随时暂停。`;
    if (!(await dialogs.confirm("发布本章", message))) return;
    try {
      await writer.publishChapter(chapterId);
      writer.notify("success", "已发布，编辑部开始工作。", { label: "查看", run: () => writer.setView("bureau") });
    } catch (error) { writer.notify("error", error instanceof Error ? error.message : String(error)); }
  }, [chapterId, dialogs, project, writer]);
  return { publishing, publish };
}
