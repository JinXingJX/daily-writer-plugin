// Painting styles for map scrolls. Built-in presets ship with Writer; a work can edit them, add its own and hide the
// ones it does not use. The prompt, palette and reference images go to GPT Image with every tile.
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, stringArray, stringValue } from "../domain/util";
import { readJson, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { projectDir } from "../storage/paths";

export type StylePalette = { paper: string; land: string; ink: string; water: string; accent: string };
export type MapStyle = {
  id: string;
  name: string;
  /** What the painting looks like, handed to the image model as is. */
  prompt: string;
  /** Things the painting must avoid. */
  avoid: string;
  palette: StylePalette;
  /** Library images whose look the model should follow (not their content). */
  referenceIds: string[];
  builtin: boolean;
};

const COMMON_AVOID = "画面里不要任何文字、字母、数字、图例、比例尺、指南针、边框和水印，不要画人物特写。";

const preset = (id: string, name: string, palette: StylePalette, prompt: string, avoid = ""): MapStyle => ({ id, name, prompt, avoid, palette, referenceIds: [], builtin: true });

export const BUILTIN_STYLES: MapStyle[] = [
  preset("ink-wash", "水墨淡彩", { paper: "#f1e9d6", land: "#e8dcc0", ink: "#2b2925", water: "#6e8fa3", accent: "#8d8270" },
    "宣纸上的水墨淡彩舆图。山体用枯笔侧锋皴擦，近浓远淡，山脚以淡墨晕开；水面大片留白，只用极淡的花青勾几道水纹；林木用点苔和米点表现；城池以几笔屋檐和城垣示意。整体色调清冷，墨色为主，赭石和花青只作淡淡的罩染，留白多，有宣纸纤维和墨的洇染。"),
  preset("blue-green", "青绿山水", { paper: "#efe9da", land: "#dfe3c8", ink: "#24323a", water: "#3f7f8c", accent: "#6fa38f" },
    "青绿山水长卷。山体先勾墨线，再以石青、石绿层层罩染，山脚衬赭石，山脊点金；云气用留白和淡金勾边，在群山之间缭绕；江河以细密鱼鳞纹画出；楼阁、桥梁、亭台点缀其间。绢本质感，色彩浓丽而沉稳。"),
  preset("old-survey", "古卷舆图", { paper: "#e3cfa4", land: "#d8bf8c", ink: "#4a2f1c", water: "#7a5a3a", accent: "#c4a36e" },
    "古代官修舆图的样式。泛黄的旧绢，边缘有磨损和折痕；山用程式化的三角山形连成山脉，水道粗细分明并画出水波线，城池画成带城垛的方框，道路以细墨线相连。只用墨色、赭石和淡黄，像博物馆里的旧图。"),
  preset("vellum", "羊皮纸奇幻", { paper: "#eadcc0", land: "#e2cfa8", ink: "#3a2a22", water: "#4e6f8f", accent: "#b9a083" },
    "奇幻小说扉页式的手绘地图。羊皮纸质感，钢笔细线排线表现山脉的明暗，森林是一簇簇小树，海面有卷曲的浪花纹样，海岸线带一圈平行的细线。棕墨为主，海水淡淡上蓝，纸面有污渍和陈旧感。"),
  preset("night-chart", "夜航星图", { paper: "#18222e", land: "#22303f", ink: "#d9c99a", water: "#5f86a8", accent: "#8a9bb0" },
    "深夜的航海图。墨蓝近黑的底色，陆地是略亮一层的蓝灰，海岸线和山脊用细金线勾出，海面洒着细小的星点和等深线；城镇是小小的金色光点。安静、精密、略带神秘。"),
  preset("line-only", "极简线稿", { paper: "#fafaf7", land: "#fafaf7", ink: "#1d1d1b", water: "#1d1d1b", accent: "#bdbdb8" },
    "极简的黑白线描地图。只用单一粗细的黑色细线：海岸线、山脊线、河流和道路；地形不填色，靠线的疏密区分；大面积留白，像建筑师的草图。"),
  // The five below follow the moods the author asked for; prompts describe the look itself, never a title or its signature designs.
  preset("ink-blade", "墨刃暗夜", { paper: "#1c1a1a", land: "#2a2624", ink: "#e8dfd0", water: "#7a2e26", accent: "#b23a2b" },
    "水墨朋克风格的暗黑武侠世界地图。纸面大部分被浓墨浸透，只留下狭窄的灰白留白当作道路和河流；山体用大笔侧锋一笔刷出，带强烈的飞白和飞溅的墨点，像刀砍出来的痕迹；海岸线锐利、棱角分明；城池和寺塔画成剪影，飞檐尖锐，有残破的塔楼和断墙。整幅只允许一种强调色——暗朱红，用来标出战场、血河和禁地，面积不超过画面的二十分之一。高对比、压抑、凌厉，像动作场面定格成的水墨画。",
    "不要明亮的天空和柔和的过渡，不要可爱的卡通元素。"),
  preset("jianghu", "江湖锦绣", { paper: "#f3ead6", land: "#eadcbc", ink: "#3a2c22", water: "#3f7f9a", accent: "#c79a3a" },
    "国风武侠的山河全景长卷，工笔重彩。群山用石青、石绿层层罩染，山脊以金线勾勒，山间云海翻涌、边缘描淡金；城镇画得精致热闹：楼阁、牌坊、拱桥、红墙黛瓦与金色屋脊，码头停着画舫；江河用细密的鱼鳞水纹，渡口有小舟；柳、竹、桃花、枫树按地区点缀出四季。俯视略带透视，像一幅可以展开的江湖长卷，明亮、雅致、饱和而不刺眼。",
    "不要写实摄影质感，不要灰暗的末世色调。"),
  preset("airy-fantasy", "清透幻想", { paper: "#eef6f6", land: "#e3f1dc", ink: "#33475b", water: "#4aa3d8", accent: "#f2b84b" },
    "清新明亮的动画风开放大陆鸟瞰图。赛璐璐式干净色块和柔和描边，阴影只有一层；海水从浅滩的薄荷青绿过渡到深处的宝石蓝，近岸能看到白色浪线；草原嫩绿、麦田金黄、山巅积雪洁白，每个地区有自己的主色调，彼此分明；午后晴天的柔光，薄云投下淡淡的影子，有轻微的体积光；建筑小巧精致，东西方风格混搭，地标带一点发光的魔法感。通透、轻快、让人想去探索。",
    "不要厚重的油画笔触，不要阴郁的天气。"),
  preset("golden-dusk", "黄金暗世", { paper: "#2a2620", land: "#3a342a", ink: "#d8bf7a", water: "#4f5a5f", accent: "#e0b552" },
    "史诗级暗黑奇幻的油画地图。厚涂笔触，看得见画刀和粗糙画布的纹理；整体是灰绿、赭褐和铅灰的低饱和色；大地破碎，有断裂的悬崖、深谷、倒塌的巨型城堡和桥梁残骸、枯死的森林和腐坏的沼泽；低垂的云层和薄雾笼罩远方，夕阳般的金色余晖从云隙洒下，是画面里唯一的高光，照亮几处古老的遗迹。古老、荒凉、庄严，像古典大师笔下的风景油画。",
    "不要鲜艳的饱和色，不要卡通描边。"),
  preset("neon-city", "霓虹都会", { paper: "#0e1020", land: "#171a33", ink: "#3fe0e8", water: "#ff3da8", accent: "#f2d23a" },
    "高科技、低生活的未来都市全息地图。深海军蓝近黑的底色；城区是密密麻麻发光的街区网格、立交桥和高架轨道，摩天楼群在俯视中像发光的晶体；海岸线用青色霓虹描边，河道和运河发出品红色的光，重要地点用荧光黄高亮并配细小的几何标记；城市外围是灰暗的荒漠、废弃工厂和管线，几条发光的高速公路伸进黑暗。叠加扫描线、轻微色差和数据噪点的故障效果。冷峻、拥挤、刺眼。",
    "不要古风元素和手绘纸张质感。"),
];

export const DEFAULT_STYLE_ID = "ink-wash";

type StoredStyles = { defaultId: string; styles: MapStyle[]; hidden: string[] };
export type StyleLibrary = { defaultId: string; styles: MapStyle[]; hidden: string[] };

function stylesFile(projectId: string) { return `${projectDir(projectId)}/atlas/styles.json`; }

const COLOR = /^#[0-9a-f]{6}$/i;
function normalizePalette(value: unknown, fallback: StylePalette): StylePalette {
  const record = asRecord(value);
  const pick = (key: keyof StylePalette) => (typeof record[key] === "string" && COLOR.test(record[key] as string) ? record[key] as string : fallback[key]);
  return { paper: pick("paper"), land: pick("land"), ink: pick("ink"), water: pick("water"), accent: pick("accent") };
}

export function normalizeStyle(value: unknown, builtin = false): MapStyle {
  const record = asRecord(value);
  const base = BUILTIN_STYLES.find((style) => style.id === record.id) ?? BUILTIN_STYLES[0];
  return {
    id: stringValue(record.id).trim() || uniqueId("style"),
    name: stringValue(record.name).trim() || "未命名风格",
    prompt: stringValue(record.prompt),
    avoid: stringValue(record.avoid),
    palette: normalizePalette(record.palette, base.palette),
    referenceIds: stringArray(record.referenceIds, 4),
    builtin,
  };
}

async function readStored(projectId: string): Promise<StoredStyles> {
  const record = asRecord(await readJson(stylesFile(projectId)));
  return { defaultId: stringValue(record.defaultId) || DEFAULT_STYLE_ID, styles: arrayValue(record.styles).map((item) => normalizeStyle(item, BUILTIN_STYLES.some((style) => style.id === asRecord(item).id))), hidden: stringArray(record.hidden, 100) };
}

/** Built-ins (as the work edited them, minus the hidden ones) followed by the work's own styles. */
export async function loadStyleLibrary(projectId: string): Promise<StyleLibrary> {
  const stored = await readStored(projectId);
  const edited = new Map(stored.styles.map((style) => [style.id, style]));
  const builtins = BUILTIN_STYLES.filter((style) => !stored.hidden.includes(style.id)).map((style) => edited.get(style.id) ?? style);
  const own = stored.styles.filter((style) => !style.builtin);
  const styles = [...builtins, ...own];
  const defaultId = styles.some((style) => style.id === stored.defaultId) ? stored.defaultId : styles[0]?.id ?? DEFAULT_STYLE_ID;
  return { defaultId, styles, hidden: stored.hidden };
}

export function findStyle(library: StyleLibrary, id: string | null | undefined): MapStyle {
  return library.styles.find((style) => style.id === id) ?? library.styles.find((style) => style.id === library.defaultId) ?? BUILTIN_STYLES[0];
}

type Listener = (projectId: string) => void;
const listeners = new Set<Listener>();
export function subscribeStyles(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

async function mutate(projectId: string, change: (stored: StoredStyles) => void) {
  await withWriterMutationLock(async () => {
    const stored = await readStored(projectId);
    change(stored);
    await writeJson(stylesFile(projectId), stored);
  });
  for (const listener of listeners) listener(projectId);
}

export async function saveStyle(projectId: string, style: MapStyle): Promise<MapStyle> {
  const builtin = BUILTIN_STYLES.some((item) => item.id === style.id);
  const saved = normalizeStyle(style, builtin);
  await mutate(projectId, (stored) => {
    stored.styles = [...stored.styles.filter((item) => item.id !== saved.id), saved];
    stored.hidden = stored.hidden.filter((id) => id !== saved.id);
  });
  return saved;
}

export async function createStyle(projectId: string, from?: MapStyle): Promise<MapStyle> {
  const base = from ?? BUILTIN_STYLES[0];
  return saveStyle(projectId, { ...base, id: uniqueId("style"), name: from ? `${from.name} 副本` : "新风格", builtin: false });
}

/** Hides a built-in or deletes the work's own style. At least one style always remains. */
export async function deleteStyle(projectId: string, id: string) {
  const library = await loadStyleLibrary(projectId);
  if (library.styles.length <= 1) throw new Error("至少要保留一种风格。");
  await mutate(projectId, (stored) => {
    stored.styles = stored.styles.filter((style) => style.id !== id);
    if (BUILTIN_STYLES.some((style) => style.id === id) && !stored.hidden.includes(id)) stored.hidden.push(id);
    if (stored.defaultId === id) stored.defaultId = library.styles.find((style) => style.id !== id)?.id ?? DEFAULT_STYLE_ID;
  });
}

/** Undoes a work's edits to a built-in and shows it again. */
export async function resetBuiltinStyle(projectId: string, id: string) {
  await mutate(projectId, (stored) => {
    stored.styles = stored.styles.filter((style) => style.id !== id);
    stored.hidden = stored.hidden.filter((item) => item !== id);
  });
}

export async function restoreHiddenStyles(projectId: string) { await mutate(projectId, (stored) => { stored.hidden = []; }); }

export async function setDefaultStyle(projectId: string, id: string) { await mutate(projectId, (stored) => { stored.defaultId = id; }); }

/** The style's part of a tile prompt. */
export function stylePrompt(style: MapStyle) {
  return [`【画风】${style.prompt.trim()}`, `【主色】纸面 ${style.palette.paper}、陆地 ${style.palette.land}、墨线 ${style.palette.ink}、水 ${style.palette.water}、强调色 ${style.palette.accent}。`, `【不要】${[style.avoid.trim(), COMMON_AVOID].filter(Boolean).join("")}`].join("\n");
}
