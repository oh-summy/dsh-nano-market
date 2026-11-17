// @oh-summy/connect-lark — per-chat 状态（**只**存会话绑定，不是配置事实源）。
//
// 模型/强度/权限/工作区的事实源是**插件配置本身**（cordis.patch.yml 的 connect-lark 条目）：
// 卡片里的选择与 Web 设置页里的修改走同一条宿主保存路径（ctx.settings.mutate），
// 写的是同一份配置——不存在第二套「卡片专属配置」。
//
// 本文件只保留无法从插件配置推导的**会话绑定**事实：
//  - sessionId：用户显式绑定的会话（选历史对话 / 新对话）；
//  - cwd：该绑定会话的工作区（历史会话可能来自别的工作区）。
// 默认对话（owned-per-chat）没有显式绑定，会话 id 由 chatId + 配置里的 defaultPath 推导。
//
// 并发写（P1-2 已定）：DSH 单进程 JS 单线程，无真并发跨 chat；用「写 .tmp + 原子 rename」即可，无需文件锁。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 单条 per-chat 状态（只记会话绑定；模型/强度/权限/工作区在插件配置里）。 */
export interface ChatState {
  /** 宿主会话 id（「新对话」产生的 host-uuid；缺省=用确定性推导 connect-lark:<chatId>@<cwdTag>） */
  sessionId?: string;
  /** 该 chat 绑定的会话所在工作区 cwd（历史会话可能来自别的工作区；缺省=插件配置的 defaultPath） */
  cwd?: string;
  updatedAt: number;
}
export type ChatStateMap = Record<string, ChatState>;

/** 状态文件位置：DSH home 下（DSH_HOME 优先，缺省 ~/.dsh）。可经 env 覆盖以便测试。 */
export function defaultStatePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "connect-lark-sessions.json");
}

/** 旧版遗留字段（曾把模型/强度/权限存在 per-chat 状态里 = 第二套配置）。
 *  2026-11-17 起事实源只有插件配置，这些字段一律丢弃并在下次写回时抹掉。 */
const LEGACY_FIELDS = ["provider", "model", "reasoningEffort", "permissionPreset"] as const;

/** 读状态文件（不存在/损坏 → 空对象；绝不因坏文件崩插件）。
 *  顺手清掉旧版遗留的设置字段——它们曾构成第二套配置事实源，不能继续留在文件里。 */
export function loadStates(path: string): ChatStateMap {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ChatStateMap = {};
    for (const [chatId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const state = { ...(raw as Record<string, unknown>) } as unknown as ChatState;
      const bag = state as unknown as Record<string, unknown>;
      for (const field of LEGACY_FIELDS) delete bag[field];
      out[chatId] = state;
    }
    return out;
  } catch {
    return {};
  }
}

/** 原子写（P1-2：.tmp + rename，单进程无需锁）。 */
export function saveStates(path: string, map: ChatStateMap): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, path);
}
