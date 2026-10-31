// @oh-summy/nano-market — 市场插件管理页。
//
// 页面本身完全在浏览器端（client-src/client.js）：Plugins 页的「Nano Market」页签
// 列出本市场注册的插件，并提供安装 / 启用 / 停用 / 卸载。
// 服务端没有需要持有的资源——安装与配置都由宿主（DSH）执行，因此这里只做最小注册，
// 让插件能被装上、被列出、被启停。
import z from "@deepseek-ai/schemastery";

type AnyCtx = any;

export const inject = [] as const;

// 空 schema：插件没有服务端配置项。cordis 会调用 Config 的标准校验接口，
// 所以这里必须给出 schemastery schema，不能省略。
export const Config = z.object({});

export function apply(ctx: AnyCtx): void {
  ctx.logger?.info?.("[nano-market] market page ready (browser module)");
}
