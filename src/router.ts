import { Env } from "./types";

export type Handler = (
  request: Request,
  env: Env,
  params: Record<string, string>
) => Promise<Response>;

type Route = {
  method: string;
  pattern: URLPattern;
  handler: Handler;
};

export class Router {
  private routes: Route[] = [];

  on(method: string, pathname: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new URLPattern({ pathname }),
      handler,
    });
    return this;
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec({ pathname: url.pathname });
      if (!match) continue;
      const params = match.pathname.groups as Record<string, string>;
      return route.handler(request, env, params);
    }

    return new Response("Not found", { status: 404 });
  }
}
