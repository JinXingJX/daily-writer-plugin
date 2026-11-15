// Original genre samples written for Writer. Locally collected third-party passages are
// excluded from source control and bundles; authors can import their own samples per work.
import epicXuanhuan from "./presets/epic-xuanhuan.txt?raw";
import eraRebirth from "./presets/era-rebirth.txt?raw";
import familyCultivation from "./presets/family-cultivation.txt?raw";
import folkHorror from "./presets/folk-horror.txt?raw";
import poorCultivator from "./presets/poor-cultivator.txt?raw";

export type PresetSample = { id: string; title: string; style: string; text: string };

export const PRESET_SAMPLES: PresetSample[] = [
  { id: "family-cultivation", title: "家族修仙群像", style: "（原创，近似《玄鉴仙族》一类）以家族为主角，跨代叙事，克制冷静，资源一分一厘都算。", text: familyCultivation },
  { id: "folk-horror", title: "民俗诡事", style: "（原创，近似《捞尸人》一类）第一人称回忆，江南水乡的行当规矩，日常里的阴冷。", text: folkHorror },
  { id: "epic-xuanhuan", title: "东方玄幻史诗", style: "（原创，近似《夜无疆》一类）宏大世界设定，短段落，意象压迫，少年在长夜里起步。", text: epicXuanhuan },
  { id: "poor-cultivator", title: "修仙轻喜·穷修士", style: "（原创，近似《没钱修什么仙？》一类）修仙界的物价与打工，算账式幽默。", text: poorCultivator },
  { id: "era-rebirth", title: "年代重生·市井", style: "（原创，近似《1979黄金时代》一类）八十年代的票证、排队和街坊，温吞里藏着心事。", text: eraRebirth },
];

export function presetSample(id: string): PresetSample | undefined {
  return PRESET_SAMPLES.find((sample) => sample.id === id);
}
