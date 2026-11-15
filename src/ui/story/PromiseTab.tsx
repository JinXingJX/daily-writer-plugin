import { Plus, Trash2 } from "lucide-react";
import { uniqueId } from "../../domain/ids";
import { normalizePower, type CorePromise, type StoryPower } from "../../story/schema";
import { useDialogs } from "../common";
import { useWriter } from "../useWriter";
import { OwnerImages } from "../images/OwnerImages";
import { ListField, TextField } from "./fields";

/** The book's core promise, the opening checklist and the powers that drive the plot. */
export function PromiseTab() {
  const writer = useWriter();
  const dialogs = useDialogs();
  const story = writer.story;
  if (!story) return null;
  const setPromise = (patch: Partial<CorePromise>) => void writer.updateStory((plan) => { plan.promise = { ...plan.promise, ...patch }; });
  const setOpening = (patch: Partial<CorePromise["opening"]>) => setPromise({ opening: { ...story.promise.opening, ...patch } });
  const setPower = (id: string, patch: Partial<StoryPower>) => void writer.updateStory((plan) => { plan.powers = plan.powers.map((power) => (power.id === id ? { ...power, ...patch } : power)); });
  const removePower = async (power: StoryPower) => {
    if (!(await dialogs.confirm("删除金手指", `删除「${power.name}」？`, { danger: true, confirmLabel: "删除" }))) return;
    void writer.updateStory((plan) => { plan.powers = plan.powers.filter((item) => item.id !== power.id); });
  };
  const promise = story.promise;
  return (
    <div className="w-notebook">
      <div className="w-notebook-col">
        <section className="w-card">
          <h3>核心承诺</h3>
          <p className="w-muted">读者点开这本书，最想反复得到的那种体验。每一章都要兑现它，或者为它铺垫。</p>
          <TextField label="一句话卖点" rows={2} value={promise.oneLiner} placeholder="主角凭什么优势、在什么关系或场景里、持续带来哪种体验" onCommit={(value) => setPromise({ oneLiner: value })} />
          <TextField label="读者要的体验" value={promise.emotionalNeed} placeholder="优越感、解谜的快感、被照顾、悲悯……" onCommit={(value) => setPromise({ emotionalNeed: value })} />
          <TextField label="主角的优势从哪来" value={promise.advantage} onCommit={(value) => setPromise({ advantage: value })} />
          <ListField label="能兑现它的场景" value={promise.sceneTypes} onCommit={(value) => setPromise({ sceneTypes: value })} />
          <ListField label="会跑偏的写法" value={promise.offPromise} onCommit={(value) => setPromise({ offPromise: value })} />
        </section>
        <section className="w-card">
          <h3>开篇五要素</h3>
          <p className="w-muted">前三章要让读者知道的五件事，不必一次说透。</p>
          <TextField label="主角是谁" value={promise.opening.who} onCommit={(value) => setOpening({ who: value })} />
          <TextField label="在哪" value={promise.opening.where} onCommit={(value) => setOpening({ where: value })} />
          <TextField label="凭什么特别" value={promise.opening.asset} onCommit={(value) => setOpening({ asset: value })} />
          <TextField label="眼下的矛盾" value={promise.opening.conflict} onCommit={(value) => setOpening({ conflict: value })} />
          <TextField label="要做的第一件事" value={promise.opening.firstEvent} onCommit={(value) => setOpening({ firstEvent: value })} />
        </section>
      </div>
      <div className="w-notebook-col">
        <section className="w-card">
          <div className="w-row"><h3>金手指与能力</h3><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => void writer.updateStory((plan) => { plan.powers.push(normalizePower({ id: uniqueId("power"), name: "新能力" })); })}><Plus size={12} />添加</button></div>
          <p className="w-muted">写清循环、限制和地位锚：限制留下行动的动机，地位越高对手和压力也越大。</p>
          {story.powers.map((power) => (
            <article key={power.id} className="w-story-item">
              <div className="w-row"><input className="w-input grow" value={power.name} onChange={(event) => setPower(power.id, { name: event.currentTarget.value })} /><button type="button" className="w-icon-btn small" aria-label="删除" onClick={() => void removePower(power)}><Trash2 size={12} /></button></div>
              <OwnerImages owner={`power:${power.id}`} title={`「${power.name}」配图`} material={`${power.name}：触发 ${power.trigger}；效果 ${power.reward}`} />
              <TextField label="使用/获取条件" value={power.trigger} onCommit={(value) => setPower(power.id, { trigger: value })} />
              <TextField label="收获" value={power.reward} onCommit={(value) => setPower(power.id, { reward: value })} />
              <TextField label="读者能感知的锚（钱、地位…）" value={power.rewardAnchor} onCommit={(value) => setPower(power.id, { rewardAnchor: value })} />
              <TextField label="代价" value={power.cost} onCommit={(value) => setPower(power.id, { cost: value })} />
              <TextField label="上限" value={power.cap} onCommit={(value) => setPower(power.id, { cap: value })} />
              <ListField label="解决不了的问题" value={power.cannotSolve} onCommit={(value) => setPower(power.id, { cannotSolve: value })} />
              <ListField label="能带来的爽点方式" value={power.payoffModes} onCommit={(value) => setPower(power.id, { payoffModes: value })} />
              <TextField label="放大的情绪" value={power.amplifiedEmotion} onCommit={(value) => setPower(power.id, { amplifiedEmotion: value })} />
              <TextField label="地位阶梯（每行：层级｜新对手｜新压力）" rows={3} value={power.statusLadder.map((rung) => [rung.level, rung.newRivals, rung.newPressure].join("｜")).join("\n")} onCommit={(value) => setPower(power.id, { statusLadder: value.split("\n").map((line) => line.split(/[|｜]/)).filter((parts) => parts[0]?.trim()).map(([level, newRivals = "", newPressure = ""]) => ({ level: level.trim(), newRivals: newRivals.trim(), newPressure: newPressure.trim() })) })} />
            </article>
          ))}
          {!story.powers.length ? <p className="w-muted">还没有登记能力。</p> : null}
        </section>
      </div>
    </div>
  );
}
