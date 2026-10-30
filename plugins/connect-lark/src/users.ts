// @oh-summy/connect-lark — 授权用户目录。
//
// 用途：配置页要能按姓名挑人（而不是让人手抄 open_id），并默认选上租户管理员。
// 数据来源：飞书通讯录 contact/v3/users/find_by_department（应用的通讯录可见范围内）。
// 没有通讯录权限时接口会失败——那时配置页降级为手填 open_id，功能不中断。

export interface DirectoryUser {
  /** 显示名 */
  name: string;
  /** open_id（授权时写进配置的 id） */
  openId: string;
  /** 是否租户管理员（默认授权对象） */
  isManager: boolean;
  /** 邮箱（可选，便于同名区分） */
  email?: string;
}

export interface DirectoryResult {
  ok: boolean;
  users: DirectoryUser[];
  /** 第一个租户管理员（没有则为 undefined） */
  manager?: DirectoryUser;
  /** 失败原因（权限不足、超时等） */
  reason?: string;
}

/** 飞书该接口的 page_size 上限是 50，超过就 400。 */
const PAGE_SIZE = 50;
/** 最多翻几页：通讯录很大时不至于把整本拉下来。 */
const MAX_PAGES = 4;

interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

/**
 * 拉取可授权用户列表。
 *
 * @param token - 飞书 tenant_access_token
 * @param fetchImpl - 注入的 fetch，便于测试
 * @param timeoutMs - 单次请求超时
 * @returns 用户列表与管理员；失败时 ok=false 且带原因
 */
export async function listDirectoryUsers(
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 8000,
): Promise<DirectoryResult> {
  const url = "https://open.feishu.cn/open-apis/contact/v3/users/find_by_department"
    + "?user_id_type=open_id&department_id=0&page_size=" + String(PAGE_SIZE);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
    });
    const body = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    if (!response.ok || !parsed || parsed.code !== 0) {
      const msg = parsed?.msg || ("HTTP " + String(response.status));
      // 99992402/99991672 之类基本都是权限范围问题，客户端据此降级。
      return { ok: false, users: [], reason: msg };
    }
    const users: DirectoryUser[] = [];
    for (const item of parsed?.data?.items ?? []) {
      if (!item?.open_id) continue;
      users.push({
        name: String(item.name ?? item.en_name ?? item.open_id),
        openId: String(item.open_id),
        isManager: item.is_tenant_manager === true,
        ...(item.email ? { email: String(item.email) } : {}),
      });
    }
    const manager = users.find((user) => user.isManager);
    return { ok: true, users, ...(manager ? { manager } : {}) };
  } catch (error) {
    return { ok: false, users: [], reason: (error as Error)?.message || "directory request failed" };
  }
}

/** 飞书 SDK 客户端里我们用到的最小形状（便于测试与解耦）。 */
export interface DirectoryClient {
  contact: {
    v3: {
      user: {
        findByDepartment(payload: {
          params: { user_id_type: string; department_id: string; page_size: number };
        }): Promise<{
          code?: number;
          msg?: string;
          data?: { items?: Array<Record<string, unknown>>; has_more?: boolean; page_token?: string };
        }>;
      };
    };
  };
}

/**
 * 通过飞书 SDK 拉取可授权用户（SDK 自带 token 缓存，调用方无需持密钥）。
 *
 * @param client - 飞书 SDK 客户端（通常是 channel.rawClient）
 * @returns 用户列表与租户管理员；失败时 ok=false 且带原因
 */
export async function fetchDirectoryUsers(client: DirectoryClient): Promise<DirectoryResult> {
  const users: DirectoryUser[] = [];
  let manager: DirectoryUser | undefined;
  let lastReason = "directory unavailable";
  try {
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.contact.v3.user.findByDepartment({
        params: {
          user_id_type: "open_id",
          department_id: "0",
          page_size: PAGE_SIZE,
          // Without the token every round re-reads page one, so people repeat
          // and anyone past the first page is never seen.
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (response?.code !== 0) {
        lastReason = response?.msg || lastReason;
        break;
      }
      const items = response?.data?.items ?? [];
      for (const item of items) {
        if (!item?.open_id) continue;
        const user: DirectoryUser = {
          name: String(item.name ?? item.en_name ?? item.open_id),
          openId: String(item.open_id),
          isManager: item.is_tenant_manager === true,
          ...(item.email ? { email: String(item.email) } : {}),
        };
        users.push(user);
        if (user.isManager && !manager) manager = user;
      }
      if (!response?.data?.has_more) break;
      pageToken = String(response?.data?.page_token ?? "");
      if (!pageToken) break;
    }
    if (users.length === 0 && !manager) {
      // 可能是权限范围问题（99992402 等），也可能是真的没有可见用户。
      return { ok: false, users: [], reason: lastReason };
    }
    return { ok: true, users, ...(manager ? { manager } : {}) };
  } catch (error) {
    return { ok: false, users: [], reason: (error as Error)?.message || "directory request failed" };
  }
}
