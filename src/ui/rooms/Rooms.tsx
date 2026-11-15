import { AtlasView } from "../atlas/AtlasView";
import { BibleView } from "../BibleView";
import { BoardView } from "../BoardView";
import { Spinner } from "../common";
import { MapView } from "../MapView";
import { ConflictsTab } from "../memory/ConflictsTab";
import { EntitiesTab } from "../memory/EntitiesTab";
import { ImpactTab } from "../memory/ImpactTab";
import { OutlineTab } from "../memory/OutlineTab";
import { OverviewTab as MemoryOverviewTab } from "../memory/OverviewTab";
import { SearchTab } from "../memory/SearchTab";
import { WorldTab } from "../memory/WorldTab";
import { NotesTab } from "../story/NotesTab";
import { OverviewTab } from "../story/OverviewTab";
import { PromiseTab } from "../story/PromiseTab";
import { ReaderTab } from "../story/ReaderTab";
import { RelationsTab } from "../story/RelationsTab";
import { SecretsTab } from "../story/SecretsTab";
import { ThreadsTab } from "../story/ThreadsTab";
import { useNotebook, type OpenChapter } from "../story/useNotebook";
import { VolumesTab } from "../story/VolumesTab";
import { useWriter, type ArchiveLens, type StoryLens } from "../useWriter";
import { ThreadScore } from "./ThreadScore";

/** Grouped: the shape of the book, what it promises, what lies under it, how it reads. */
export const STORY_LENSES: { value: StoryLens; label: string }[][] = [
  [{ value: "score", label: "线索谱" }, { value: "threads", label: "线索表" }, { value: "board", label: "卡片墙" }, { value: "atlas", label: "世界地图" }, { value: "map", label: "结构图" }],
  [{ value: "promise", label: "承诺" }, { value: "volumes", label: "卷规划" }],
  [{ value: "secrets", label: "明暗线" }, { value: "relations", label: "关系" }],
  [{ value: "reader", label: "读者" }, { value: "notes", label: "笔记" }, { value: "brief", label: "简报" }],
];

export const ARCHIVE_LENSES: { value: ArchiveLens; label: string }[] = [
  { value: "people", label: "人物与势力" }, { value: "bible", label: "设定库" }, { value: "world", label: "世界观" }, { value: "outline", label: "全书提要" },
  { value: "conflicts", label: "矛盾" }, { value: "impact", label: "改动影响" }, { value: "search", label: "全书查找" }, { value: "memory", label: "记忆管理" },
];

/** Story: threads, cards, map and the plan, one lens at a time. */
export function StoryRoom({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const api = useNotebook();
  const lens = writer.storyLens;
  if (lens === "board") return <BoardView />;
  if (lens === "map") return <MapView />;
  if (lens === "atlas") return <AtlasView onOpenChapter={onOpenChapter} />;
  if (lens === "score") return <ThreadScore onOpenChapter={onOpenChapter} />;
  return (
    <div className="w-memory">
      <div className="w-memory-body">
        {!api.loaded || !writer.story ? <p className="w-muted pad"><Spinner size={11} /> 正在读取…</p>
          : lens === "brief" ? <OverviewTab {...api} onOpenChapter={onOpenChapter} />
          : lens === "promise" ? <PromiseTab />
          : lens === "threads" ? <ThreadsTab notebook={api.notebook} onOpenChapter={onOpenChapter} />
          : lens === "secrets" ? <SecretsTab />
          : lens === "relations" ? <RelationsTab />
          : lens === "volumes" ? <VolumesTab />
          : lens === "notes" ? <NotesTab {...api} onOpenChapter={onOpenChapter} />
          : <ReaderTab {...api} onOpenChapter={onOpenChapter} />}
      </div>
    </div>
  );
}

/** Archive: what the book has established, from the author's bible and from story memory. */
export function ArchiveRoom({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const lens = writer.archiveLens;
  if (lens === "bible") return <BibleView />;
  return (
    <div className="w-memory">
      <div className="w-memory-body">
        {lens === "memory" ? <MemoryOverviewTab /> : null}
        {lens === "outline" ? <OutlineTab onOpenChapter={onOpenChapter} /> : null}
        {lens === "world" ? <WorldTab /> : null}
        {lens === "people" ? <EntitiesTab onOpenChapter={onOpenChapter} /> : null}
        {lens === "conflicts" ? <ConflictsTab onOpenChapter={onOpenChapter} /> : null}
        {lens === "search" ? <SearchTab onOpenChapter={onOpenChapter} /> : null}
        {lens === "impact" ? <ImpactTab onOpenChapter={onOpenChapter} /> : null}
      </div>
    </div>
  );
}
