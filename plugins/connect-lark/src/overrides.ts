// @oh-summy/connect-lark — session-id cwd fingerprint.
//
// 一等公民语义（2026-11-15 定稿）：模型/强度/权限/工作区的事实源是**会话本身**
// （agent.model.select / permissionPresets.set 写会话投影，sessionController.create
// 开宿主标准会话），per-chat 显式选择记在 session-map.ts。本模块只保留 cwd 指纹：
// 会话 id 的确定性推导依赖它（connect-lark:<chatId>@<cwdTag(cwd)>），
// 改工作区 = 换指纹 = 换会话（cwd 是会话出身属性，不可原地迁移）。

/** Session-identity fingerprint for a cwd (simple polynomial, cache invalidation
 *  only): 改工作区必须换新会话才能生效（cwd 是会话出身属性）。 */
export function cwdTag(path: string): string {
  if (!path) return "";
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return "@" + h.toString(36);
}
