import { createInterface } from "node:readline";
import { openSemantic, type SemanticRepo } from "../api.ts";
import { messageOf } from "../errors.ts";

const VERSION = "0.2.0";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(sem: SemanticRepo, args: Record<string, unknown>, client: string): Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });

const TOOLS: Tool[] = [
  {
    name: "sem_log",
    description: "History by intent: each commit with its recorded or proposed intent and touched paths. Lookup only.",
    inputSchema: { type: "object", properties: { range: str("Revision range, e.g. main..feature"), limit: { type: "number" } } },
    run: (sem, a) => sem.log({ range: a.range ? [String(a.range)] : [], limit: typeof a.limit === "number" ? a.limit : 50 }),
  },
  {
    name: "sem_show",
    description: "All semantic artifacts for one object (commit or blob), with provenance.",
    inputSchema: { type: "object", properties: { rev: str("Revision, default HEAD") } },
    run: (sem, a) => sem.show(a.rev ? String(a.rev) : "HEAD"),
  },
  {
    name: "sem_entity",
    description: "History of a function, class or method across renames and moves: versions, intents and commit ids.",
    inputSchema: { type: "object", properties: { name: str("Entity name, e.g. loadUser or Session.refresh") }, required: ["name"] },
    run: (sem, a) => sem.entity(String(a.name)),
  },
  {
    name: "sem_why",
    description: "Why an entity exists, answered only from recorded intents, with cited commits; says when the record is insufficient.",
    inputSchema: { type: "object", properties: { name: str("Entity name") }, required: ["name"] },
    run: (sem, a) => sem.why(String(a.name)),
  },
  {
    name: "sem_search",
    description: "Search code entities and commits by meaning across all branches (local index, no model).",
    inputSchema: {
      type: "object",
      properties: { query: str("What to look for"), includeUnreachable: { type: "boolean" }, limit: { type: "number" } },
      required: ["query"],
    },
    run: (sem, a) =>
      sem.search(String(a.query), { includeUnreachable: a.includeUnreachable === true, limit: typeof a.limit === "number" ? a.limit : 10 }),
  },
  {
    name: "sem_propose_intent",
    description: "Propose the intent of a commit. Stored as a proposal tagged with your identity; a person decides whether to accept it.",
    inputSchema: {
      type: "object",
      properties: { rev: str("Commit"), text: str("Proposed intent, one sentence"), confidence: { type: "number" } },
      required: ["rev", "text"],
    },
    run: (sem, a, client) =>
      sem.proposeIntent(String(a.rev), String(a.text), { agent: client, confidence: typeof a.confidence === "number" ? a.confidence : undefined }),
  },
];

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * A Model Context Protocol server over stdio (newline-delimited JSON-RPC),
 * exposing git-sem to agents. Proposals made through it are tagged with the
 * connecting client's name.
 *
 *   git sem mcp
 */
export async function mcpCommand(_args: string[]): Promise<number> {
  const sem = await openSemantic();
  let client = "agent";
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (req.id === undefined) continue; // notifications need no reply

    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: req.id, error: { code, message } });

    switch (req.method) {
      case "initialize": {
        const info = req.params?.clientInfo as { name?: string } | undefined;
        if (info?.name) client = info.name;
        reply({
          protocolVersion: (req.params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "git-sem", version: VERSION },
        });
        break;
      }
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({ tools: TOOLS.map(({ run: _run, ...t }) => t) });
        break;
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === req.params?.name);
        if (!tool) {
          fail(-32602, `unknown tool: ${String(req.params?.name)}`);
          break;
        }
        try {
          const result = await tool.run(sem, (req.params?.arguments as Record<string, unknown>) ?? {}, client);
          reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } });
        } catch (e) {
          reply({ content: [{ type: "text", text: messageOf(e) }], isError: true });
        }
        break;
      }
      default:
        fail(-32601, `method not found: ${req.method}`);
    }
  }
  return 0;
}
