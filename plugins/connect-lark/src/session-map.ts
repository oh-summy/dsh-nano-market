// @oh-summy/connect-lark — per-chat 状态（一等公民维度的单一事实源）。
//
// 模型/强度/权限/工作区不再写插件配置（那是全局、多处生效同一件事），而是：
//  - 会话投影（agent.model.select / permissionPresets.set 写会话日志，重启自动重放）；
//  - 本文件记录「每个 chat 当前在哪个会话 + 该 chat 的显式选择」，供卡片同步展示与重启恢复。
// 默认对话（owned-per-chat）的会话 id 是确定性的（connect-lark:<chatId>@<cwdTag>），
// 只有「新对话」（host-uuid 会话）才把 sessionId 记在这里。
//
// 并发写（P1-2 已定）：DSH 单进程 JS 单线程，无真并发跨 chat；用「写 .tmp + 原子 rename」即可，无需文件锁。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 单条 per-chat 状态。 */
export interface ChatState {
  /** 宿主会话 id（「新对话」产生的 host-uuid；缺省=用确定性推导 connect-lark:<chatId>@<cwdTag>） */
  sessionId?: string;
  /** 该 chat 当前工作区 cwd（会话出身属性；一等公民） */
  cwd?: string;
  /** 该 chat 显式选的模型/强度/权限（写进会话投影；缺省=跟随 DSH 默认） */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionPreset?: string;
  updatedAt: number;
}
export type ChatStateMap = Record<string, ChatState>;

/** 状态文件位置：DSH home 下（DSH_HOME 优先，缺省 ~/.dsh）。可经 env 覆盖以便测试。 */
export function defaultStatePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "connect-lark-sessions.json");
}

/** 读状态文件（不存在/损坏 → 空对象；绝不因坏文件崩插件）。 */
export function loadStates(path: string): ChatStateMap {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChatStateMap) : {};
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
