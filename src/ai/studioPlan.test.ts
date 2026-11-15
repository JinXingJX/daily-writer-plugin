import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeHost, uninstallFakeHost } from "../test/fakeHost";
import { normalizePlan } from "./pipelines/nextChapter";
import { loadStudioPlan, saveStudioPlan } from "./studioPlan";

describe("studio plan", () => {
  beforeEach(() => { installFakeHost(); });
  afterEach(() => uninstallFakeHost());
  const plan = normalizePlan({ title: "缸底的字", scenes: [{ title: "旧屋", goal: "找证据", words: 900 }] });

  it("gives the plan back to the conversation that made it", async () => {
    await saveStudioPlan("p1", "s1", plan, [{ message: "没人接棒", sceneIndex: null } as never]);
    const loaded = await loadStudioPlan("p1", "s1");
    expect(loaded?.plan.title).toBe("缸底的字");
    expect(loaded?.plan.scenes[0].goal).toBe("找证据");
    expect(loaded?.warnings).toHaveLength(1);
  });

  it("does not show another conversation's plan, and keeps one plan per work", async () => {
    await saveStudioPlan("p1", "s1", plan, []);
    expect(await loadStudioPlan("p1", "s2")).toBeNull();
    await saveStudioPlan("p1", "s2", plan, []);
    expect(await loadStudioPlan("p1", "s1")).toBeNull();
    expect(await loadStudioPlan("p2", "s1")).toBeNull();
  });
});
