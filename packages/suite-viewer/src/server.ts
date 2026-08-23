import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSuiteFromFile, type EvalSuite } from "@sysprompt-lab/core";
import { GoldUpdateError, NSFW_SEVERITY_TAGS, isNsfwMetric, type CaseGoldUpdate } from "./gold.js";
import {
  buildCaseDetail,
  buildCaseSummaries,
  buildOverview,
  imageOptionsForSuite,
} from "./model.js";
import { caseImageResolve } from "./paths.js";
import { SuiteConflictError, saveSuiteCase, suiteMtimeMs } from "./save.js";

export const DEFAULT_VIEWER_HOST = "127.0.0.1";
export const DEFAULT_VIEWER_PORT = 8787;

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface SuiteViewerOptions {
  suitePath: string;
  imageDir?: string;
}

export interface ListenSuiteViewerOptions extends SuiteViewerOptions {
  host?: string;
  port?: number;
}

export interface SuiteViewerHandle {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface SuiteViewerPayload {
  path: string;
  mtimeMs: number;
  overview: ReturnType<typeof buildOverview>;
  cases: ReturnType<typeof buildCaseSummaries>;
  nsfwTags: readonly string[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": type.startsWith("text/html") ? "no-store" : "no-cache",
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function loadViewerSuite(options: SuiteViewerOptions): {
  suite: EvalSuite;
  mtimeMs: number;
  imageOptions: ReturnType<typeof imageOptionsForSuite>;
} {
  if (!existsSync(options.suitePath)) {
    throw new Error(`Suite file not found: ${options.suitePath}`);
  }
  return {
    suite: loadSuiteFromFile(options.suitePath),
    mtimeMs: suiteMtimeMs(options.suitePath),
    imageOptions: imageOptionsForSuite(options.suitePath, options.imageDir),
  };
}

function suitePayload(options: SuiteViewerOptions): SuiteViewerPayload {
  const { suite, mtimeMs, imageOptions } = loadViewerSuite(options);
  const cases = buildCaseSummaries(suite, imageOptions);
  return {
    path: options.suitePath,
    mtimeMs,
    overview: buildOverview(suite, cases),
    cases,
    nsfwTags: NSFW_SEVERITY_TAGS,
  };
}

function findCase(suite: EvalSuite, caseId: string) {
  const evalCase = suite.cases.find((item) => item.id === caseId);
  if (!evalCase) {
    return undefined;
  }
  const split = suite.splits.train.case_ids.includes(caseId)
    ? ("train" as const)
    : suite.splits.val.case_ids.includes(caseId)
      ? ("val" as const)
      : ("unassigned" as const);
  return { evalCase, split };
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const name = STATIC_FILES[pathname];
  if (!name) {
    return false;
  }
  const filePath = join(PUBLIC_DIR, name);
  if (!existsSync(filePath)) {
    sendText(res, 404, "Not found", "text/plain; charset=utf-8");
    return true;
  }
  const ext = extname(name);
  const type =
    ext === ".js"
      ? "text/javascript; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : "text/html; charset=utf-8";
  sendText(res, 200, readFileSync(filePath, "utf8"), type);
  return true;
}

function serveCaseImage(
  options: SuiteViewerOptions,
  caseId: string,
  res: ServerResponse,
): void {
  const { suite, imageOptions } = loadViewerSuite(options);
  const found = findCase(suite, caseId);
  if (!found) {
    sendJson(res, 404, { error: `Unknown case "${caseId}"` });
    return;
  }
  const image = caseImageResolve(found.evalCase.input, imageOptions);
  if (!image.resolved.ok || image.resolved.remote) {
    sendJson(res, 404, { error: "Image not found on disk" });
    return;
  }
  const filePath = image.resolved.path;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Image not found on disk" });
    return;
  }
  const type = IMAGE_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  createReadStream(filePath).pipe(res);
}

function parseSaveBody(body: unknown): CaseGoldUpdate & {
  expectedMtimeMs?: number;
  force?: boolean;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GoldUpdateError("Save body must be a JSON object");
  }
  const obj = body as {
    gold?: unknown;
    notes?: unknown;
    expectedMtimeMs?: unknown;
    force?: unknown;
  };
  const update: CaseGoldUpdate & { expectedMtimeMs?: number; force?: boolean } = {};
  if ("gold" in obj) {
    update.gold = obj.gold;
  }
  if ("notes" in obj) {
    if (obj.notes !== undefined && obj.notes !== null && typeof obj.notes !== "string") {
      throw new GoldUpdateError("notes must be a string");
    }
    update.notes = obj.notes ?? null;
  }
  if (obj.expectedMtimeMs !== undefined) {
    if (typeof obj.expectedMtimeMs !== "number" || !Number.isFinite(obj.expectedMtimeMs)) {
      throw new GoldUpdateError("expectedMtimeMs must be a number");
    }
    update.expectedMtimeMs = obj.expectedMtimeMs;
  }
  if (obj.force !== undefined) {
    update.force = Boolean(obj.force);
  }
  return update;
}

export function createSuiteViewerListener(options: SuiteViewerOptions): RequestListener {
  return (req, res) => {
    void handleRequest(options, req, res);
  };
}

async function handleRequest(
  options: SuiteViewerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method ?? "GET";

    if (method === "GET" && serveStatic(pathname, res)) {
      return;
    }
    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && pathname === "/api/suite") {
      sendJson(res, 200, suitePayload(options));
      return;
    }

    const caseImage = pathname.match(/^\/api\/cases\/([^/]+)\/image$/);
    if (method === "GET" && caseImage) {
      serveCaseImage(options, caseImage[1]!, res);
      return;
    }

    const caseRoute = pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (caseRoute) {
      const caseId = caseRoute[1]!;
      if (method === "GET") {
        const { suite, mtimeMs, imageOptions } = loadViewerSuite(options);
        const found = findCase(suite, caseId);
        if (!found) {
          sendJson(res, 404, { error: `Unknown case "${caseId}"` });
          return;
        }
        const detail = buildCaseDetail(suite, found.evalCase, found.split, imageOptions);
        sendJson(res, 200, {
          path: options.suitePath,
          mtimeMs,
          nsfw: isNsfwMetric(suite.metric),
          nsfwTags: NSFW_SEVERITY_TAGS,
          case: detail,
        });
        return;
      }
      if (method === "POST") {
        const body = parseSaveBody(await readJsonBody(req));
        const saved = saveSuiteCase(options.suitePath, caseId, body, {
          expectedMtimeMs: body.expectedMtimeMs,
          force: body.force,
        });
        sendJson(res, 200, { ok: true, mtimeMs: saved.mtimeMs, suite: suitePayload(options) });
        return;
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof SuiteConflictError) {
      sendJson(res, 409, { error: error.message, conflict: true, mtimeMs: error.mtimeMs });
      return;
    }
    if (error instanceof GoldUpdateError || (error instanceof SyntaxError && error.message.includes("JSON"))) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message });
  }
}

export function listenSuiteViewer(options: ListenSuiteViewerOptions): Promise<SuiteViewerHandle> {
  const host = options.host ?? DEFAULT_VIEWER_HOST;
  const port = options.port ?? DEFAULT_VIEWER_PORT;
  const server = createServer(createSuiteViewerListener(options));
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://${host}:${actualPort}`,
        host,
        port: actualPort,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
              } else {
                closeResolve();
              }
            });
          }),
      });
    });
  });
}
