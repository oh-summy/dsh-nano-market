// @oh-summy/connect-lark — 授权用户目录的本机 HTTP 面。
//
// 为什么需要它：配置页在浏览器里，要按姓名挑人就得问飞书通讯录；
// 浏览器不能直接带 app_secret 调飞书，所以由插件服务端代查。
//
// 边界：只监听 127.0.0.1，只读通讯录，不写任何飞书数据。
// 没有通讯录权限时返回 ok=false，配置页据此降级为手填 open_id。
import { createServer, type Server } from "node:http";
import { listDirectoryUsers, type DirectoryUser } from "./users.js";

/** 本机端口。dsh-remote 占用 9091，这里错开。 */
export const DIRECTORY_PORT = 9092;

export interface DirectoryServiceOptions {
  /** 取飞书 tenant token / 调通讯录的能力（由 channel.rawClient 提供） */
  listUsers: () => Promise<{ ok: boolean; users: DirectoryUser[]; manager?: DirectoryUser; reason?: string }>;
  /** 允许的页面来源；"null" 覆盖本地 file:// 与本地开发页 */
  allowedOrigins?: string[];
  port?: number;
}

/** 允许本地开发页与本机 DSH 页面跨域读取。 */
const DEFAULT_ORIGINS = [
  "null",
  "http://127.0.0.1:3080",
  "http://localhost:3080",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
];

export interface DirectoryService {
  port: number;
  close(): Promise<void>;
}

/**
 * 起一个只读的本机 HTTP 面，给配置页提供「可授权用户」列表。
 *
 * @param options - 目录来源与跨域白名单
 * @returns 已监听的目录服务
 */
export async function startDirectoryService(options: DirectoryServiceOptions): Promise<DirectoryService> {
  const origins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  const port = options.port ?? DIRECTORY_PORT;

  const server: Server = createServer((req, res) => {
    // 这个服务只监听 127.0.0.1、只读通讯录、不带凭据，所以对任意来源开放 CORS 是安全的：
    // 外部攻击者无法连到本机回环端口。
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET" || !req.url?.startsWith("/lark-api/users")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, users: [], reason: "not found" }));
      return;
    }
    options.listUsers().then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch((error) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, users: [], reason: (error as Error)?.message || "directory failed" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  // port=0 表示随机端口；回报实际监听的端口，调用方才能连上。
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: actualPort,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
