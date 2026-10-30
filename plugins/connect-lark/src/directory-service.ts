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
/**
 * 端口被别的实例占用时**不**改用别的端口：飞书的 open_id 按应用隔离，
 * 读到另一个应用的通讯录会让人以为授权成功、实际在本应用里无效。
 * 宁可不提供搜索（配置页会降级为手填 open_id），也不要串号。
 */

export interface DirectoryServiceOptions {
  /** 通讯录 + 群聊目录（服务端代查，浏览器不直接带密钥） */
  directory: () => Promise<import("./users.js").Directory>;
  /** 允许读取的页面来源（DSH 自己的地址 + 回环） */
  allowedOrigins?: Set<string>;
  port?: number;
}

/** 允许本地开发页与本机 DSH 页面跨域读取。 */
const DEFAULT_ORIGINS = [
  "null",
  "http://127.0.0.1:3080",
  "http://localhost:3080",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  "http://127.0.0.1:8083",
  "http://localhost:8083",
  "http://127.0.0.1:8084",
  "http://localhost:8084",
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
  const port = options.port ?? DIRECTORY_PORT;
  return listen(options, port);
}

async function listen(options: DirectoryServiceOptions, port: number): Promise<DirectoryService> {
  const origins = options.allowedOrigins ?? new Set<string>();

  const server: Server = createServer((req, res) => {
    // CORS 白名单由调用方按「这个 DSH 实例自己的地址」算好（广告 URL + 回环）。
    // 之前用固定清单，Cloudflare 隧道域名一换就 403，选择器直接失效。
    const requestOrigin = String(req.headers.origin ?? "");
    if (requestOrigin && !origins.has(requestOrigin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, users: [], chats: [], reason: "origin not allowed" }));
      return;
    }
    if (requestOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET" || !req.url?.startsWith("/lark-api/directory")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, users: [], reason: "not found" }));
      return;
    }
    options.directory().then((result) => {
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
