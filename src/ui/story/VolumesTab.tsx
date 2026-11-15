import { sortedVolumes } from "../../domain/documents";
import { normalizeVolumePlan, type VolumePlan } from "../../story/schema";
import { useWriter } from "../useWriter";
import { ListField, TextField } from "./fields";

/** Per volume: where the stage ends, why the protagonist must cross into the next, the core loop, what carries over. */
export function VolumesTab() {
  const writer = useWriter();
  const { project, story } = writer;
  if (!project || !story) return null;
  const planOf = (volumeId: string) => story.volumes.find((plan) => plan.volumeId === volumeId) ?? (normalizeVolumePlan({ volumeId }) as VolumePlan);
  const setPlan = (volumeId: string, patch: Partial<VolumePlan>) => void writer.updateStory((plan) => { plan.volumes = [...plan.volumes.filter((item) => item.volumeId !== volumeId), { ...planOf(volumeId), ...patch }]; });
  return (
    <div className="w-volume-plans">
      {sortedVolumes(project).map((volume) => {
        const plan = planOf(volume.id);
        return (
          <section key={volume.id} className="w-card">
            <h3>{volume.title}</h3>
            <TextField label="阶段终点" rows={2} value={plan.endpoint} placeholder="这一卷结束时，什么事完成了" onCommit={(value) => setPlan(volume.id, { endpoint: value })} />
            <ListField label="主角跨进下一阶段的理由" value={plan.threshold.reasons} placeholder="非去不可的得失：危机、收获、承诺（每行一条）" onCommit={(value) => setPlan(volume.id, { threshold: { ...plan.threshold, reasons: value } })} />
            <TextField label="展示过的准备" value={plan.threshold.preparation} onCommit={(value) => setPlan(volume.id, { threshold: { ...plan.threshold, preparation: value } })} />
            <TextField label="门后有什么" value={plan.threshold.beyond} onCommit={(value) => setPlan(volume.id, { threshold: { ...plan.threshold, beyond: value } })} />
            <ListField label="核心循环（每行一步）" value={plan.coreLoop} onCommit={(value) => setPlan(volume.id, { coreLoop: value })} />
            <ListField label="要带进下一阶段的关系" value={plan.transition.carriedRelations} onCommit={(value) => setPlan(volume.id, { transition: { ...plan.transition, carriedRelations: value } })} />
            <ListField label="要带过去的承诺与谜团" value={plan.transition.carriedPromises} onCommit={(value) => setPlan(volume.id, { transition: { ...plan.transition, carriedPromises: value } })} />
            <ListField label="桥梁人物" value={plan.transition.bridgeCharacters} onCommit={(value) => setPlan(volume.id, { transition: { ...plan.transition, bridgeCharacters: value } })} />
          </section>
        );
      })}
    </div>
  );
}
